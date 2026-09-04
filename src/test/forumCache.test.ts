import { beforeEach, describe, expect, it } from "vitest";
import {
  appendForumTestPost,
  getCachedPosts,
  getForumDraft,
  getForumScroll,
  getForumTestPosts,
  getUnreadChannels,
  purgeLegacyForumLocalState,
  setCachedPosts,
  setChannelRead,
  setForumDraft,
  setForumScroll,
} from "@/hooks/useForumCache";

describe("forum test-mode messages", () => {
  beforeEach(() => localStorage.clear());

  it("shares the test sandbox between test participants in the same community", () => {
    appendForumTestPost("CAMPUS", "IIT_DELHI", { id: "test-1", author_id: "test-user-1", content: "hello" });
    appendForumTestPost("CAMPUS", "IIT_DELHI", { id: "test-2", author_id: "test-user-2", content: "hi" });

    expect(getForumTestPosts("CAMPUS", "IIT_DELHI")).toEqual([
      { id: "test-1", author_id: "test-user-1", content: "hello" },
      { id: "test-2", author_id: "test-user-2", content: "hi" },
    ]);
    expect(getForumTestPosts("GLOBAL", "IIT_ALL")).toEqual([]);
  });

  it.each([2, 4, 10])("keeps ordered messages from %i participants", (participantCount) => {
    for (let index = 0; index < participantCount; index += 1) {
      appendForumTestPost("COHORT", "IIT_DELHI|BTECH|GENERAL|2026", {
        id: `test-${index}`, author_id: `participant-${index}`, created_at: new Date(index).toISOString(),
      });
    }

    const posts = getForumTestPosts("COHORT", "IIT_DELHI|BTECH|GENERAL|2026");
    expect(posts.map((post) => post.author_id)).toEqual(
      Array.from({ length: participantCount }, (_, index) => `participant-${index}`),
    );
  });

  it("caps a room at the latest 100 test messages", () => {
    for (let index = 0; index < 105; index += 1) {
      appendForumTestPost("GLOBAL", "IIT_ALL", { id: `test-${index}` });
    }

    const posts = getForumTestPosts("GLOBAL", "IIT_ALL");
    expect(posts).toHaveLength(100);
    expect(posts[0].id).toBe("test-5");
  });

  it("isolates recent room snapshots per signed-in user and keeps localStorage lean", () => {
    const messages = Array.from({ length: 125 }, (_, index) => ({ id: `message-${index}` }));
    setCachedPosts("CAMPUS", "IIT_DELHI", messages, "viewer-a");
    setCachedPosts("CAMPUS", "IIT_DELHI", [{ id: "viewer-b-message" }], "viewer-b");

    expect(getCachedPosts("CAMPUS", "IIT_DELHI", "viewer-a")).toHaveLength(125);
    expect(getCachedPosts("CAMPUS", "IIT_DELHI", "viewer-b")).toEqual([{ id: "viewer-b-message" }]);
    const persisted = JSON.parse(localStorage.getItem("forum_cache_viewer-a_CAMPUS_IIT_DELHI") || "[]");
    expect(persisted).toHaveLength(100);
    expect(persisted[0].id).toBe("message-25");
  });

  it("isolates drafts, scroll positions, and unread state per signed-in user", () => {
    setForumDraft("CAMPUS", "IIT_DELHI", "viewer A draft", "viewer-a");
    setForumDraft("CAMPUS", "IIT_DELHI", "viewer B draft", "viewer-b");
    setForumScroll("CAMPUS", "IIT_DELHI", 120, "viewer-a");
    setForumScroll("CAMPUS", "IIT_DELHI", 640, "viewer-b");
    setChannelRead("GLOBAL", "IIT_ALL_tech", "viewer-a");

    expect(getForumDraft("CAMPUS", "IIT_DELHI", "viewer-a")).toBe("viewer A draft");
    expect(getForumDraft("CAMPUS", "IIT_DELHI", "viewer-b")).toBe("viewer B draft");
    expect(getForumScroll("CAMPUS", "IIT_DELHI", "viewer-a")).toBe(120);
    expect(getForumScroll("CAMPUS", "IIT_DELHI", "viewer-b")).toBe(640);
    expect(getUnreadChannels("viewer-a").GLOBAL_IIT_ALL_tech).toBeUndefined();
    expect(getUnreadChannels("viewer-b").GLOBAL_IIT_ALL_tech).toBe(true);
    expect(getForumDraft("CAMPUS", "IIT_DELHI", null)).toBe("");
  });

  it("purges unattributable legacy room state without deleting scoped state", () => {
    localStorage.setItem("forum_unread_dots", JSON.stringify({ GLOBAL_IIT_ALL: true }));
    localStorage.setItem("forum_draft_GLOBAL_IIT_ALL", "private legacy draft");
    localStorage.setItem("forum_scroll_GLOBAL_IIT_ALL", "900");
    setForumDraft("GLOBAL", "IIT_ALL", "safe draft", "viewer-a");

    purgeLegacyForumLocalState();

    expect(localStorage.getItem("forum_unread_dots")).toBeNull();
    expect(localStorage.getItem("forum_draft_GLOBAL_IIT_ALL")).toBeNull();
    expect(localStorage.getItem("forum_scroll_GLOBAL_IIT_ALL")).toBeNull();
    expect(getForumDraft("GLOBAL", "IIT_ALL", "viewer-a")).toBe("safe draft");
  });
});
