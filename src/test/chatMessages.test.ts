import { describe, expect, it } from "vitest";
import { mergeChatTimeline, uniqueChatMessages } from "@/lib/chatMessages";

const message = (id: string, createdAt: string, roomId = "room-1", clientId?: string) => ({
  id, created_at: createdAt, room_id: roomId, client_id: clientId || null,
});

describe("chat timeline merging", () => {
  it("does not erase a live arrival when initial history resolves later", () => {
    const live = message("live-3", "2026-08-31T10:00:03.000Z");
    const initialHistory = [
      message("history-1", "2026-08-31T10:00:01.000Z"),
      message("history-2", "2026-08-31T10:00:02.000Z"),
    ];

    expect(mergeChatTimeline([live], initialHistory, "room-1").map((item) => item.id))
      .toEqual(["history-1", "history-2", "live-3"]);
  });

  it("replaces an optimistic row with the matching server acknowledgement", () => {
    const optimistic = message("optimistic-client-1", "2026-08-31T10:00:01.000Z", "room-1", "client-1");
    const persisted = message("server-1", "2026-08-31T10:00:01.100Z", "room-1", "client-1");

    expect(uniqueChatMessages([optimistic, persisted])).toEqual([persisted]);
  });

  it("cannot leak cached messages from another room", () => {
    const stale = message("stale", "2026-08-31T10:00:00.000Z", "room-2");
    const current = message("current", "2026-08-31T10:00:01.000Z");

    expect(mergeChatTimeline([stale], [current], "room-1")).toEqual([current]);
  });
});
