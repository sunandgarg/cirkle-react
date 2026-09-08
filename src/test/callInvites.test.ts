import { describe, expect, it } from "vitest";
import { directCallPeerId, getCallInvitePath, isDirectCallRoom, parseCallInviteNotification, parseCallInviteQuery } from "@/lib/callInvites";

const now = Date.parse("2026-09-04T10:00:00.000Z");
const roomId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("call invitations", () => {
  it("shows call controls only for a UUID-bound direct chat peer", () => {
    expect(isDirectCallRoom({ id: roomId, is_group: false, peerId: sessionId })).toBe(true);
    expect(isDirectCallRoom({ id: roomId, is_group: true, peerId: sessionId })).toBe(false);
    expect(isDirectCallRoom({ id: roomId, is_group: false, peerId: null })).toBe(false);
    expect(isDirectCallRoom({ id: roomId, is_group: false, peerId: "../member" })).toBe(false);
  });

  it("recovers a direct peer from the canonical room key when enrichment is delayed", () => {
    const viewerId = "33333333-3333-4333-8333-333333333333";
    const peerId = "44444444-4444-4444-8444-444444444444";
    const room = { id: roomId, is_group: false, direct_key: `${viewerId}:${peerId}` };

    expect(directCallPeerId(room, viewerId)).toBe(peerId);
    expect(isDirectCallRoom(room, viewerId)).toBe(true);
    expect(isDirectCallRoom(room, sessionId)).toBe(false);
  });

  it("builds a safe, expiring chat route from a structured notification", () => {
    const invite = parseCallInviteNotification({
      type: "call_invite",
      room_id: roomId,
      call_session_id: sessionId,
      call_mode: "video",
      expires_at: "2026-09-04T10:05:00.000Z",
      link: "javascript:alert(1)",
    }, now);

    expect(invite).toEqual({ roomId, sessionId, mode: "video", expiresAt: now + 300_000 });
    expect(getCallInvitePath(invite!)).toBe(`/chats/${roomId}?call=video&session=${sessionId}&expires=${now + 300_000}`);
  });

  it("rejects expired and malformed notification data", () => {
    expect(parseCallInviteNotification({
      type: "call_invite", room_id: roomId, call_session_id: sessionId,
      call_mode: "audio", expires_at: "2026-09-04T10:00:00.000Z",
    }, now)).toBeNull();
    expect(parseCallInviteNotification({
      type: "call_invite", room_id: "../admin", call_session_id: sessionId,
      call_mode: "audio", expires_at: "2026-09-04T10:05:00.000Z",
    }, now)).toBeNull();
  });

  it("accepts only a complete, unexpired incoming-call query", () => {
    const valid = new URLSearchParams({ call: "audio", session: sessionId, expires: String(now + 300_000) });
    expect(parseCallInviteQuery(roomId, valid, now)).toEqual({ roomId, sessionId, mode: "audio", expiresAt: now + 300_000 });

    valid.set("expires", String(now));
    expect(parseCallInviteQuery(roomId, valid, now)).toBeNull();
    valid.set("expires", String(now + 300_000));
    valid.set("call", "screen");
    expect(parseCallInviteQuery(roomId, valid, now)).toBeNull();
  });
});
