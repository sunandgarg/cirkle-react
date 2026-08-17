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
