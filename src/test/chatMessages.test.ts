import { describe, expect, it } from "vitest";
import {
  isChatMessageRealtimeEvent, mergeChatTimeline, reconcileChatTimeline, uniqueChatMessages,
} from "@/lib/chatMessages";

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

  it("ignores membership and call events sharing the AppSync room channel", () => {
    expect(isChatMessageRealtimeEvent({ table: "messages", eventType: "INSERT" })).toBe(true);
    expect(isChatMessageRealtimeEvent({ table: "chat_members", eventType: "UPDATE" })).toBe(false);
    expect(isChatMessageRealtimeEvent({ table: "call_sessions", eventType: "INSERT" })).toBe(false);
  });

  it("authoritatively reconciles an old edit and a missed delete after foreground resume", () => {
    const current = [
      { ...message("old-edited", "2026-08-31T10:00:01.000Z"), content: "before edit" },
      { ...message("old-deleted", "2026-08-31T10:00:02.000Z"), content: "delete me" },
      { ...message("newest", "2026-08-31T10:00:03.000Z"), content: "latest" },
    ];
    const authoritative = [
      { ...message("old-edited", "2026-08-31T10:00:01.000Z"), content: "after edit" },
      { ...message("newest", "2026-08-31T10:00:03.000Z"), content: "latest" },
    ];

    const recovered = reconcileChatTimeline(current, authoritative, "room-1");
    expect(recovered.map((item) => item.id)).toEqual(["old-edited", "newest"]);
    expect(recovered[0].content).toBe("after edit");
  });

  it("keeps an unacknowledged outbox message during authoritative recovery", () => {
    const optimistic = message("optimistic-client-1", "2026-08-31T10:00:02.000Z", "room-1", "client-1");
    expect(reconcileChatTimeline([optimistic], [], "room-1")).toEqual([optimistic]);
  });
});
