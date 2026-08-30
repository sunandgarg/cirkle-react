import { describe, expect, it } from "vitest";
import { forumPostContent, normalizeForumPoll, resolveForumSendIdentity, type ForumSendSnapshot } from "@/lib/forumSend";

const snapshot: ForumSendSnapshot = {
  scopeType: "COHORT",
  scopeKey: "IIT_DELHI|MBA|GENERAL|2026",
  content: "hello",
  isAnonymous: false,
  replyToId: null,
  imageFingerprint: null,
  fileFingerprint: null,
  pollQuestion: "",
  pollOptions: [],
};

describe("forum send identity", () => {
  it("reuses an id for an unchanged manual retry", () => {
    const first = resolveForumSendIdentity(null, snapshot, () => "message-1");
    const retry = resolveForumSendIdentity(first, snapshot, () => "message-2");
    expect(retry.id).toBe("message-1");
  });

  it("creates a new id when the user changes the message", () => {
    const first = resolveForumSendIdentity(null, snapshot, () => "message-1");
    const changed = resolveForumSendIdentity(first, { ...snapshot, content: "changed" }, () => "message-2");
    expect(changed.id).toBe("message-2");
  });
});

describe("forum poll delivery", () => {
  it("creates non-empty persisted content for a poll-only message", () => {
    expect(forumPostContent({
      content: "",
      pollQuestion: "Where should we meet?",
      pollOptions: ["Library", "Cafe"],
    })).toBe("📊 Where should we meet?");
  });

  it("requires a question and at least two non-empty options", () => {
    expect(() => normalizeForumPoll({ pollQuestion: "", pollOptions: ["One"] }))
      .toThrow("Add a question");
    expect(() => normalizeForumPoll({ pollQuestion: "Pick one", pollOptions: ["One", " "] }))
      .toThrow("at least two");
  });
});
