import { describe, expect, it } from "vitest";
import { getNotificationActionLabel, getNotificationNavigationTarget, safeInternalNotificationPath } from "@/lib/notifications";

describe("notification navigation", () => {
  it("maps both current and legacy connection notifications", () => {
    const base = { id: "n1", user_id: "u1", created_at: new Date().toISOString() };
    expect(getNotificationNavigationTarget({ ...base, type: "connection", title: "New connection request" })).toBe("/network?tab=pending");
    expect(getNotificationNavigationTarget({ ...base, type: "connection", title: "Connection accepted" })).toBe("/network?tab=connected");
    expect(getNotificationActionLabel({ ...base, type: "connection_request" })).toBe("Review request");
  });

  it("allows only same-origin application paths", () => {
    expect(safeInternalNotificationPath("/jobs?job=123")).toBe("/jobs?job=123");
    expect(safeInternalNotificationPath("javascript:alert(1)")).toBeNull();
    expect(safeInternalNotificationPath("//evil.example/jobs")).toBeNull();
    expect(safeInternalNotificationPath("/admin")).toBeNull();
    expect(safeInternalNotificationPath("https://evil.example/jobs")).toBeNull();
  });

  it("never falls back to a stored route for an expired call invite", () => {
    expect(getNotificationNavigationTarget({
      id: "expired-call", user_id: "u1", type: "call_invite", created_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-01T00:01:00.000Z", link: "/chats/room?call=video",
    })).toBeNull();
  });

  it("does not expose a valid call action unless runtime calls are enabled", () => {
    const call = {
      id: "call", user_id: "u1", type: "call_invite", created_at: new Date().toISOString(),
      room_id: "11111111-1111-4111-8111-111111111111",
      call_session_id: "22222222-2222-4222-8222-222222222222",
      call_mode: "video", expires_at: "2999-01-01T00:00:00.000Z",
    };
    expect(getNotificationNavigationTarget(call)).toBeNull();
    expect(getNotificationActionLabel(call)).toBeNull();
    expect(getNotificationNavigationTarget(call, { dailyCallsEnabled: true })).toContain("/chats/");
    expect(getNotificationActionLabel(call, { dailyCallsEnabled: true })).toBe("Join call");
  });
});
