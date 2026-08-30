export type ForumSendSnapshot = {
  scopeType: string;
  scopeKey: string;
  content: string;
  isAnonymous: boolean;
  replyToId: string | null;
  imageFingerprint: string | null;
  fileFingerprint: string | null;
  pollQuestion: string;
  pollOptions: string[];
};

export type ForumSendIdentity = {
  id: string;
  fingerprint: string;
};

export type ForumPostContentSource = {
  content?: string | null;
  image?: unknown;
  file?: { name: string } | null;
  voicePath?: string | null;
  pollQuestion?: string | null;
  pollOptions?: string[] | null;
};

export const normalizeForumPoll = (source: ForumPostContentSource) => {
  const question = source.pollQuestion?.trim() || "";
  const options = (source.pollOptions || []).map((option) => option.trim()).filter(Boolean);
  if (!question && options.length) throw new Error("Add a question before sending this poll.");
  if (question && options.length < 2) throw new Error("Add at least two poll options.");
  return { question, options };
};

export const forumPostContent = (source: ForumPostContentSource) => {
  const content = source.content?.trim();
  if (content) return content;
  if (source.image) return "📷";
  if (source.file) return `📎 ${source.file.name}`;
  if (source.voicePath) return "🎤 Voice message";
  const { question } = normalizeForumPoll(source);
  return question ? `📊 ${question}` : "";
};

export const forumSendFingerprint = (snapshot: ForumSendSnapshot) => JSON.stringify({
  ...snapshot,
  content: snapshot.content.trim(),
  pollQuestion: snapshot.pollQuestion.trim(),
  pollOptions: snapshot.pollOptions.map((option) => option.trim()).filter(Boolean),
});

/**
 * Reuses the same database id when a user retries an unchanged send. If the
 * first response was lost after Postgres committed, the primary key turns the
 * retry into an acknowledgement instead of a duplicate message.
 */
export const resolveForumSendIdentity = (
  current: ForumSendIdentity | null,
  snapshot: ForumSendSnapshot,
  createId: () => string = () => crypto.randomUUID(),
): ForumSendIdentity => {
  const fingerprint = forumSendFingerprint(snapshot);
  return current?.fingerprint === fingerprint
    ? current
    : { id: createId(), fingerprint };
};
