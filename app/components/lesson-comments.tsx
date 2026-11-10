import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { MessageSquare } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { UserAvatar } from "~/components/user-avatar";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";
import type {
  CommentThread,
  CommentView,
} from "~/services/lessonCommentService";

type CommentActionData = { commentOk: boolean; commentError: string | null };

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

function timeAgo(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

export function LessonComments({
  lessonId,
  courseSlug,
  canComment,
  isLoggedIn,
  comments,
}: {
  lessonId: number;
  courseSlug: string;
  canComment: boolean;
  isLoggedIn: boolean;
  comments: CommentThread[];
}) {
  if (!canComment) {
    return (
      <section className="mb-8 rounded-lg border p-6 text-center">
        <MessageSquare className="mx-auto mb-2 size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          <Link
            to={
              isLoggedIn
                ? `/courses/${courseSlug}`
                : `/login?redirectTo=${encodeURIComponent(`/courses/${courseSlug}`)}`
            }
            className="font-medium text-foreground underline"
          >
            Enroll
          </Link>{" "}
          to join the discussion.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
        <MessageSquare className="size-5" />
        Discussion ({comments.length})
      </h2>
      <CommentForm
        fetcherKey={`comment-new-${lessonId}`}
        placeholder="Ask a question or share a thought…"
        submitLabel="Comment"
      />
      <ul className="mt-6 space-y-6">
        {comments.map((thread) => (
          <li key={thread.id}>
            <Comment comment={thread} />
            <div className="ml-11 mt-3 space-y-3 border-l pl-4">
              {thread.replies.map((reply) => (
                <Comment key={reply.id} comment={reply} />
              ))}
              {!thread.deleted && <ReplyToggle parentId={thread.id} />}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CommentForm({
  fetcherKey,
  placeholder,
  submitLabel,
  parentId,
  commentId,
  defaultValue = "",
  onDone,
  autoFocus,
}: {
  fetcherKey: string;
  placeholder?: string;
  submitLabel: string;
  parentId?: number;
  commentId?: number;
  defaultValue?: string;
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const fetcher = useFetcher<CommentActionData>({ key: fetcherKey });
  const [body, setBody] = useState(defaultValue);
  const submitting = fetcher.state !== "idle";
  const prevState = useRef(fetcher.state);

  useEffect(() => {
    if (
      prevState.current !== "idle" &&
      fetcher.state === "idle" &&
      fetcher.data?.commentOk
    ) {
      setBody("");
      onDone?.();
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data, onDone]);

  const tooLong = body.length > MAX_COMMENT_LENGTH;

  return (
    <fetcher.Form method="post" className="space-y-2">
      <input
        type="hidden"
        name="intent"
        value={commentId ? "edit-comment" : "create-comment"}
      />
      {parentId && <input type="hidden" name="parentId" value={parentId} />}
      {commentId && <input type="hidden" name="commentId" value={commentId} />}
      <Textarea
        name="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={tooLong || !!fetcher.data?.commentError}
      />
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-xs ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
        >
          {fetcher.data?.commentError && !submitting ? (
            <span className="text-destructive">{fetcher.data.commentError}</span>
          ) : (
            `${body.length}/${MAX_COMMENT_LENGTH}`
          )}
        </span>
        <div className="flex gap-2">
          {onDone && (
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            disabled={submitting || tooLong || body.trim().length === 0}
          >
            {submitting ? "Saving…" : submitLabel}
          </Button>
        </div>
      </div>
    </fetcher.Form>
  );
}

function ReplyToggle({ parentId }: { parentId: number }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        Reply
      </button>
    );
  }
  return (
    <CommentForm
      fetcherKey={`comment-reply-${parentId}`}
      placeholder="Write a reply…"
      submitLabel="Reply"
      parentId={parentId}
      onDone={() => setOpen(false)}
      autoFocus
    />
  );
}

function Comment({ comment }: { comment: CommentView }) {
  const [editing, setEditing] = useState(false);
  const deleteFetcher = useFetcher<CommentActionData>({
    key: `comment-delete-${comment.id}`,
  });
  const deleting = deleteFetcher.state !== "idle";

  if (comment.deleted || !comment.author) {
    return <p className="text-sm italic text-muted-foreground">[deleted]</p>;
  }

  return (
    <div className={`flex gap-3 ${deleting ? "opacity-50" : ""}`}>
      <UserAvatar name={comment.author.name} avatarUrl={comment.author.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{comment.author.name}</span>
          {comment.badge && (
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                comment.badge === "instructor"
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {comment.badge === "instructor" ? "Instructor" : "Admin"}
            </span>
          )}
          <time
            dateTime={comment.createdAt}
            title={new Date(comment.createdAt).toLocaleString()}
            className="text-xs text-muted-foreground"
            suppressHydrationWarning
          >
            {timeAgo(comment.createdAt)}
          </time>
          {comment.edited && (
            <span className="text-xs text-muted-foreground">(edited)</span>
          )}
        </div>
        {editing ? (
          <div className="mt-2">
            <CommentForm
              fetcherKey={`comment-edit-${comment.id}`}
              submitLabel="Save"
              commentId={comment.id}
              defaultValue={comment.body ?? ""}
              onDone={() => setEditing(false)}
              autoFocus
            />
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
            {comment.body}
          </p>
        )}
        {!editing && (comment.canEdit || comment.canDelete) && (
          <div className="mt-1 flex gap-3 text-xs">
            {comment.canEdit && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-muted-foreground hover:text-foreground"
              >
                Edit
              </button>
            )}
            {comment.canDelete && (
              <deleteFetcher.Form
                method="post"
                onSubmit={(e) => {
                  if (!confirm("Delete this comment?")) e.preventDefault();
                }}
              >
                <input type="hidden" name="intent" value="delete-comment" />
                <input type="hidden" name="commentId" value={comment.id} />
                <button
                  className="text-muted-foreground hover:text-destructive"
                  disabled={deleting}
                >
                  Delete
                </button>
              </deleteFetcher.Form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
