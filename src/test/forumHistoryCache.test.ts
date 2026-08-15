import { describe, expect, it } from "vitest";
import { MAX_ROOM_HISTORY, mergeForumHistoryPosts } from "@/lib/forumHistoryCache";

describe("forum browser history cache", () => {
  it("merges cached pages and live messages without duplicates", () => {
    const cached = [
      { id: "m-1", content: "old", created_at: "2026-08-15T10:00:00.000Z" },
      { id: "m-2", content: "before edit", created_at: "2026-08-15T10:01:00.000Z" },
    ];
    const incoming = [
      { id: "m-2", content: "edited", created_at: "2026-08-15T10:01:00.000Z" },
      { id: "m-3", content: "live", created_at: "2026-08-15T10:02:00.000Z" },
    ];

    const merged = mergeForumHistoryPosts(cached, incoming);
    expect(merged.map((post) => post.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(merged[1].content).toBe("edited");
  });

  it("keeps 1,000 simultaneous messages scrollable in chronological order", () => {
    const burst = Array.from({ length: 1_000 }, (_, index) => ({
      id: `m-${index}`,
      created_at: new Date(1_800_000_000_000 + index).toISOString(),
    })).reverse();

    const merged = mergeForumHistoryPosts([], burst);
    expect(merged).toHaveLength(1_000);
    expect(merged[0].id).toBe("m-0");
    expect(merged.at(-1)?.id).toBe("m-999");
  });

  it("bounds long-term room history without losing the newest messages", () => {
    const messages = Array.from({ length: MAX_ROOM_HISTORY + 25 }, (_, index) => ({
      id: `m-${index}`,
      created_at: new Date(1_800_000_000_000 + index).toISOString(),
    }));

    const merged = mergeForumHistoryPosts([], messages);
    expect(merged).toHaveLength(MAX_ROOM_HISTORY);
    expect(merged[0].id).toBe("m-25");
    expect(merged.at(-1)?.id).toBe(`m-${MAX_ROOM_HISTORY + 24}`);
  });
});
