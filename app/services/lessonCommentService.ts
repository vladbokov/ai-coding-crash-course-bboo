import { eq, asc } from "drizzle-orm";
import { db } from "~/db";
import {
  lessonComments,
  lessons,
  modules,
  courses,
  users,
  UserRole,
} from "~/db/schema";
import { isUserEnrolled } from "~/services/enrollmentService";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";

// ─── Lesson Comment Service ───
// Discussion on a lesson: top-level comments plus one level of replies.
// Who can take part: students enrolled in the course, the course's own
// instructor, and admins. Only those people can read the comments.
// Deletes are soft (deletedAt) so replies under a deleted comment survive.
// Uses positional parameters (project convention).

export type CommentErrorCode = "not_found" | "forbidden" | "invalid";

export class CommentError extends Error {
  constructor(
    public code: CommentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CommentError";
  }
}

export type CommentBadge = "instructor" | "admin" | null;

export type CommentView = {
  id: number;
  body: string | null; // null when the comment is deleted
  deleted: boolean;
  edited: boolean;
  createdAt: string;
  author: { id: number; name: string; avatarUrl: string | null } | null;
  badge: CommentBadge;
  canEdit: boolean;
  canDelete: boolean;
};

export type CommentThread = CommentView & { replies: CommentView[] };

function getLessonCourse(lessonId: number) {
  return db
    .select({ courseId: courses.id, instructorId: courses.instructorId })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

function getUserRole(userId: number) {
  return db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get()?.role;
}

function normalizeBody(body: string) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new CommentError("invalid", "Comment cannot be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new CommentError(
      "invalid",
      `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`
    );
  }
  return trimmed;
}

/** Can this user read and post comments on lessons of this course? */
export function canAccessCourseComments(
  userId: number | null,
  courseId: number,
  instructorId: number
) {
  if (!userId) return false;
  if (userId === instructorId) return true;
  if (getUserRole(userId) === UserRole.Admin) return true;
  return isUserEnrolled(userId, courseId);
}

export function canAccessLessonComments(userId: number | null, lessonId: number) {
  const course = getLessonCourse(lessonId);
  if (!course) return false;
  return canAccessCourseComments(userId, course.courseId, course.instructorId);
}

function canModerate(userId: number, instructorId: number) {
  return userId === instructorId || getUserRole(userId) === UserRole.Admin;
}

export function findComment(commentId: number) {
  return db
    .select()
    .from(lessonComments)
    .where(eq(lessonComments.id, commentId))
    .get();
}

export function createComment(
  userId: number,
  lessonId: number,
  body: string,
  parentId: number | null
) {
  const course = getLessonCourse(lessonId);
  if (!course) throw new CommentError("not_found", "Lesson not found");

  if (!canAccessCourseComments(userId, course.courseId, course.instructorId)) {
    throw new CommentError("forbidden", "You cannot comment on this lesson");
  }

  const text = normalizeBody(body);

  if (parentId !== null) {
    const parent = findComment(parentId);
    if (!parent || parent.lessonId !== lessonId) {
      throw new CommentError("not_found", "Comment to reply to not found");
    }
    if (parent.parentId !== null) {
      throw new CommentError("invalid", "Replies can only be one level deep");
    }
    if (parent.deletedAt) {
      throw new CommentError("invalid", "Cannot reply to a deleted comment");
    }
  }

  // Same timestamp for both so "edited" is exactly updatedAt !== createdAt.
  const now = new Date().toISOString();
  return db
    .insert(lessonComments)
    .values({ lessonId, userId, parentId, body: text, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

export function updateComment(userId: number, commentId: number, body: string) {
  const comment = findComment(commentId);
  if (!comment || comment.deletedAt) {
    throw new CommentError("not_found", "Comment not found");
  }
  if (comment.userId !== userId) {
    throw new CommentError("forbidden", "You can only edit your own comments");
  }
  // Authors who have lost access (e.g. unenrolled) can no longer edit.
  if (!canAccessLessonComments(userId, comment.lessonId)) {
    throw new CommentError("forbidden", "You cannot edit this comment");
  }

  const text = normalizeBody(body);

  return db
    .update(lessonComments)
    .set({ body: text, updatedAt: new Date().toISOString() })
    .where(eq(lessonComments.id, commentId))
    .returning()
    .get();
}

export function deleteComment(userId: number, commentId: number) {
  const comment = findComment(commentId);
  if (!comment || comment.deletedAt) {
    throw new CommentError("not_found", "Comment not found");
  }

  const course = getLessonCourse(comment.lessonId);
  if (!course) throw new CommentError("not_found", "Lesson not found");

  const isAuthorWithAccess =
    comment.userId === userId &&
    canAccessCourseComments(userId, course.courseId, course.instructorId);

  if (!isAuthorWithAccess && !canModerate(userId, course.instructorId)) {
    throw new CommentError("forbidden", "You cannot delete this comment");
  }

  return db
    .update(lessonComments)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(lessonComments.id, commentId))
    .returning()
    .get();
}

/**
 * Comments for a lesson as viewed by `viewerId`: top-level comments newest
 * first, replies oldest first. Deleted comments are hidden unless they still
 * have visible replies, in which case they show as a "[deleted]" placeholder.
 * Returns an empty list for viewers without access.
 */
export function getLessonComments(
  viewerId: number | null,
  lessonId: number
): CommentThread[] {
  const course = getLessonCourse(lessonId);
  if (!course) return [];
  if (!canAccessCourseComments(viewerId, course.courseId, course.instructorId)) {
    return [];
  }

  const viewerCanModerate = canModerate(viewerId!, course.instructorId);

  const rows = db
    .select({
      comment: lessonComments,
      author: {
        id: users.id,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: users.role,
      },
    })
    .from(lessonComments)
    .innerJoin(users, eq(lessonComments.userId, users.id))
    .where(eq(lessonComments.lessonId, lessonId))
    .orderBy(asc(lessonComments.createdAt), asc(lessonComments.id))
    .all();

  const toView = ({ comment, author }: (typeof rows)[number]): CommentView => {
    const deleted = comment.deletedAt !== null;
    const isOwn = comment.userId === viewerId;
    const badge: CommentBadge =
      author.id === course.instructorId
        ? "instructor"
        : author.role === UserRole.Admin
          ? "admin"
          : null;
    return {
      id: comment.id,
      body: deleted ? null : comment.body,
      deleted,
      edited: !deleted && comment.updatedAt !== comment.createdAt,
      createdAt: comment.createdAt,
      author: deleted
        ? null
        : { id: author.id, name: author.name, avatarUrl: author.avatarUrl },
      badge: deleted ? null : badge,
      canEdit: !deleted && isOwn,
      canDelete: !deleted && (isOwn || viewerCanModerate),
    };
  };

  const threads = new Map<number, CommentThread>();
  const topLevel: CommentThread[] = [];

  for (const row of rows) {
    if (row.comment.parentId === null) {
      const thread = { ...toView(row), replies: [] };
      threads.set(row.comment.id, thread);
      topLevel.push(thread);
    }
  }
  for (const row of rows) {
    if (row.comment.parentId !== null && !row.comment.deletedAt) {
      threads.get(row.comment.parentId)?.replies.push(toView(row));
    }
  }

  return topLevel
    .filter((t) => !t.deleted || t.replies.length > 0)
    .reverse();
}
