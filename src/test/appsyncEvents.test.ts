import { describe, expect, it } from "vitest";
import {
  appSyncKeepAliveTimeout,
  buildAppSyncAuthorization,
  getAppSyncEventFrames,
  isValidClientAppSyncChannel,
} from "@/lib/appsyncEvents";

describe("AppSync Events authorization", () => {
  it("uses the HTTP API host for realtime handshakes and subscriptions", () => {
    expect(buildAppSyncAuthorization(
      "https://example.appsync-api.ap-south-1.amazonaws.com/event",
      "signed-user-token",
    )).toEqual({
      Authorization: "signed-user-token",
      host: "example.appsync-api.ap-south-1.amazonaws.com",
    });
  });

  it("accepts the scalar event shape used by HTTP AppSync publishes", () => {
    const frame = JSON.stringify({ eventType: "INSERT", new: { id: "message-1" } });
    expect(getAppSyncEventFrames({ event: frame })).toEqual([frame]);
    expect(getAppSyncEventFrames({ event: [frame] })).toEqual([frame]);
    expect(getAppSyncEventFrames({ events: [frame] })).toEqual([frame]);
  });

  it("rejects wildcard, malformed and over-deep subscription paths", () => {
    expect(isValidClientAppSyncChannel("/chat/11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isValidClientAppSyncChannel("/forum/type/digest/*")).toBe(false);
    expect(isValidClientAppSyncChannel("/chat/private_room")).toBe(false);
    expect(isValidClientAppSyncChannel("/one/two/three/four/five/six")).toBe(false);
  });

  it("uses the service keep-alive timeout only inside safe bounds", () => {
    expect(appSyncKeepAliveTimeout(120_000)).toBe(120_000);
    expect(appSyncKeepAliveTimeout(1)).toBe(300_000);
    expect(appSyncKeepAliveTimeout("not-a-number")).toBe(300_000);
  });
});
