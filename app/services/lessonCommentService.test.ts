import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  createComment,
  updateComment,
  deleteComment,
  getLessonComments,
  canAccessLessonComments,
  CommentError,
} from "./lessonCommentService";

let lessonId: number;
let otherLessonId: number;
let admin: typeof schema.users.$inferSelect;
let outsider: typeof schema.users.$inferSelect;
let classmate: typeof schema.users.$inferSelect;

function createUser(name: string, email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

function enroll(userId: number) {
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function expectCommentError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommentError);
    expect((e as CommentError).code).toBe(code);
    return;
  }
  throw new Error("Expected CommentError");
}

describe("lessonCommentService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);

    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module 1", position: 1 })
      .returning()
      .get();
    lessonId = testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "Lesson 1", position: 1 })
      .returning()
      .get().id;
    otherLessonId = testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "Lesson 2", position: 2 })
      .returning()
      .get().id;

    admin = createUser("Admin", "admin@example.com", schema.UserRole.Admin);
    outsider = createUser("Out", "out@example.com", schema.UserRole.Student);
    classmate = createUser("Mate", "mate@example.com", schema.UserRole.Student);
    enroll(base.user.id);
    enroll(classmate.id);
  });

  describe("access", () => {
    it("allows enrolled students, the course instructor and admins", () => {
      expect(canAccessLessonComments(base.user.id, lessonId)).toBe(true);
      expect(canAccessLessonComments(base.instructor.id, lessonId)).toBe(true);
      expect(canAccessLessonComments(admin.id, lessonId)).toBe(true);
    });

    it("denies unenrolled users, other instructors and logged-out viewers", () => {
      const otherInstructor = createUser(
        "Other",
        "other@example.com",
        schema.UserRole.Instructor
      );
      expect(canAccessLessonComments(outsider.id, lessonId)).toBe(false);
      expect(canAccessLessonComments(otherInstructor.id, lessonId)).toBe(false);
      expect(canAccessLessonComments(null, lessonId)).toBe(false);
    });

    it("rejects comments from users without access", () => {
      expectCommentError(
        () => createComment(outsider.id, lessonId, "hi", null),
        "forbidden"
      );
    });

    it("returns no comments to viewers without access", () => {
      createComment(base.user.id, lessonId, "hi", null);
      expect(getLessonComments(outsider.id, lessonId)).toEqual([]);
      expect(getLessonComments(null, lessonId)).toEqual([]);
    });
  });

  describe("createComment", () => {
    it("trims the body and rejects empty comments", () => {
      expect(createComment(base.user.id, lessonId, "  hello\n ", null).body).toBe(
        "hello"
      );
      expectCommentError(
        () => createComment(base.user.id, lessonId, "   ", null),
        "invalid"
      );
    });

    it("accepts 1000 characters and rejects 1001", () => {
      expect(() =>
        createComment(base.user.id, lessonId, "a".repeat(1000), null)
      ).not.toThrow();
      expectCommentError(
        () => createComment(base.user.id, lessonId, "a".repeat(1001), null),
        "invalid"
      );
    });

    it("allows one level of replies only", () => {
      const top = createComment(base.user.id, lessonId, "Q", null);
      const reply = createComment(base.instructor.id, lessonId, "A", top.id);
      expect(reply.parentId).toBe(top.id);
      expectCommentError(
        () => createComment(base.user.id, lessonId, "nested", reply.id),
        "invalid"
      );
    });

    it("rejects replies to a comment on another lesson", () => {
      const top = createComment(base.user.id, otherLessonId, "Q", null);
      expectCommentError(
        () => createComment(base.user.id, lessonId, "A", top.id),
        "not_found"
      );
    });
  });

  describe("updateComment", () => {
    it("lets the author edit and marks the comment edited", () => {
      const c = createComment(base.user.id, lessonId, "old", null);
      expect(getLessonComments(base.user.id, lessonId)[0].edited).toBe(false);
      updateComment(base.user.id, c.id, "new");
      const [view] = getLessonComments(base.user.id, lessonId);
      expect(view.body).toBe("new");
      expect(view.edited).toBe(true);
    });

    it("does not let others edit, not even the instructor", () => {
      const c = createComment(base.user.id, lessonId, "old", null);
      expectCommentError(
        () => updateComment(base.instructor.id, c.id, "x"),
        "forbidden"
      );
    });

    it("does not let an unenrolled author edit", () => {
      const c = createComment(base.user.id, lessonId, "old", null);
      testDb
        .delete(schema.enrollments)
        .where(eq(schema.enrollments.userId, base.user.id))
        .run();
      expectCommentError(() => updateComment(base.user.id, c.id, "x"), "forbidden");
    });
  });

  describe("deleteComment", () => {
    it("lets the author, the instructor and admins delete", () => {
      const a = createComment(base.user.id, lessonId, "1", null);
      const b = createComment(base.user.id, lessonId, "2", null);
      const c = createComment(base.user.id, lessonId, "3", null);
      deleteComment(base.user.id, a.id);
      deleteComment(base.instructor.id, b.id);
      deleteComment(admin.id, c.id);
      expect(getLessonComments(base.user.id, lessonId)).toEqual([]);
    });

    it("does not let another student delete", () => {
      const c = createComment(base.user.id, lessonId, "1", null);
      expectCommentError(() => deleteComment(classmate.id, c.id), "forbidden");
    });

    it("keeps a deleted comment with replies as a placeholder", () => {
      const top = createComment(base.user.id, lessonId, "Q", null);
      createComment(classmate.id, lessonId, "A", top.id);
      deleteComment(base.user.id, top.id);

      const [thread] = getLessonComments(classmate.id, lessonId);
      expect(thread.deleted).toBe(true);
      expect(thread.body).toBeNull();
      expect(thread.author).toBeNull();
      expect(thread.replies).toHaveLength(1);
    });

    it("hides a deleted comment once its replies are deleted too", () => {
      const top = createComment(base.user.id, lessonId, "Q", null);
      const reply = createComment(classmate.id, lessonId, "A", top.id);
      deleteComment(base.user.id, top.id);
      deleteComment(classmate.id, reply.id);
      expect(getLessonComments(classmate.id, lessonId)).toEqual([]);
    });

    it("keeps an unenrolled student's comments visible", () => {
      createComment(classmate.id, lessonId, "still here", null);
      testDb
        .delete(schema.enrollments)
        .where(eq(schema.enrollments.userId, classmate.id))
        .run();
      expect(getLessonComments(base.user.id, lessonId)[0].body).toBe(
        "still here"
      );
    });
  });

  describe("getLessonComments", () => {
    it("orders top-level newest first and replies oldest first", () => {
      const first = createComment(base.user.id, lessonId, "first", null);
      createComment(base.user.id, lessonId, "second", null);
      createComment(classmate.id, lessonId, "r1", first.id);
      createComment(base.instructor.id, lessonId, "r2", first.id);

      const threads = getLessonComments(base.user.id, lessonId);
      expect(threads.map((t) => t.body)).toEqual(["second", "first"]);
      expect(threads[1].replies.map((r) => r.body)).toEqual(["r1", "r2"]);
    });

    it("badges the course instructor and admins", () => {
      createComment(base.user.id, lessonId, "s", null);
      createComment(base.instructor.id, lessonId, "i", null);
      createComment(admin.id, lessonId, "a", null);
      const badges = Object.fromEntries(
        getLessonComments(base.user.id, lessonId).map((t) => [t.body, t.badge])
      );
      expect(badges).toEqual({ s: null, i: "instructor", a: "admin" });
    });

    it("sets edit/delete permissions for the viewer", () => {
      createComment(classmate.id, lessonId, "x", null);
      const [asStudent] = getLessonComments(base.user.id, lessonId);
      expect(asStudent.canEdit).toBe(false);
      expect(asStudent.canDelete).toBe(false);
      const [asInstructor] = getLessonComments(base.instructor.id, lessonId);
      expect(asInstructor.canEdit).toBe(false);
      expect(asInstructor.canDelete).toBe(true);
      const [asAuthor] = getLessonComments(classmate.id, lessonId);
      expect(asAuthor.canEdit).toBe(true);
      expect(asAuthor.canDelete).toBe(true);
    });
  });
});
