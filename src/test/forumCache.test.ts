import { beforeEach, describe, expect, it } from "vitest";
import { appendForumTestPost, getForumTestPosts } from "@/hooks/useForumCache";

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
});
