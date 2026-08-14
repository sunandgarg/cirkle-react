import { beforeEach, describe, expect, it } from "vitest";
import { appendForumTestPost, getForumTestPosts } from "@/hooks/useForumCache";

describe("forum test-mode messages", () => {
  beforeEach(() => localStorage.clear());

  it("persists messages per test phone and community", () => {
    appendForumTestPost("9999999999", "CAMPUS", "IIT_DELHI", { id: "test-1", content: "hello" });

    expect(getForumTestPosts("9999999999", "CAMPUS", "IIT_DELHI")).toEqual([
      { id: "test-1", content: "hello" },
    ]);
    expect(getForumTestPosts("8888888888", "CAMPUS", "IIT_DELHI")).toEqual([]);
    expect(getForumTestPosts("9999999999", "GLOBAL", "IIT_ALL")).toEqual([]);
  });

  it("caps a room at the latest 100 test messages", () => {
    for (let index = 0; index < 105; index += 1) {
      appendForumTestPost("9999999999", "GLOBAL", "IIT_ALL", { id: `test-${index}` });
    }

    const posts = getForumTestPosts("9999999999", "GLOBAL", "IIT_ALL");
    expect(posts).toHaveLength(100);
    expect(posts[0].id).toBe("test-5");
  });
});
