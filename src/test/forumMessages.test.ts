import { describe, expect, it } from "vitest";
import { acknowledgeForumPost } from "@/lib/forumMessages";

describe("acknowledgeForumPost", () => {
  it("immediately appends an acknowledged message", () => {
    const next = acknowledgeForumPost([], {
      id: "message-1",
      content: "Visible immediately",
      created_at: "2026-08-15T12:00:00.000Z",
    });

    expect(next).toHaveLength(1);
    expect(next[0].content).toBe("Visible immediately");
  });

  it("merges duplicate realtime acknowledgements without hiding or duplicating the message", () => {
    const current = [{
      id: "message-1",
      content: "Visible immediately",
      created_at: "2026-08-15T12:00:00.000Z",
      is_pending: true,
    }];
    const next = acknowledgeForumPost(current, {
      id: "message-1",
      content: "Visible immediately",
      created_at: "2026-08-15T12:00:00.000Z",
      is_pending: false,
    });

    expect(next).toHaveLength(1);
    expect(next[0].is_pending).toBe(false);
  });

  it("bounds busy-room memory while keeping the newest messages", () => {
    const current = Array.from({ length: 50 }, (_, index) => ({
      id: `message-${index}`,
      created_at: new Date(index * 1000).toISOString(),
    }));
    const next = acknowledgeForumPost(current, {
      id: "message-new",
      created_at: new Date(60_000).toISOString(),
    }, 50);

    expect(next).toHaveLength(50);
    expect(next.at(-1)?.id).toBe("message-new");
    expect(next.some((post) => post.id === "message-0")).toBe(false);
  });
});
