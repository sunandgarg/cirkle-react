import { describe, expect, it } from "vitest";
import { buildAppSyncAuthorization } from "@/lib/appsyncEvents";

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
});
