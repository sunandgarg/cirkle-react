import { describe, expect, it } from "vitest";
import { getCallInvitePath, parseCallInviteNotification, parseCallInviteQuery } from "@/lib/callInvites";

const now = Date.parse("2026-09-04T10:00:00.000Z");
const roomId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("call invitations", () => {
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
