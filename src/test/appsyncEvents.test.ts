import { describe, expect, it } from "vitest";
import { buildAppSyncAuthorization, dispatchRealtimeOutboxWithRetry, getAppSyncEventFrames } from "@/lib/appsyncEvents";

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

  it("retries transient dispatcher failures with bounded backoff", async () => {
    const attempts: Array<number> = [];
    const waits: number[] = [];
    const delivered = await dispatchRealtimeOutboxWithRetry(
      async () => {
        attempts.push(attempts.length + 1);
        return { error: attempts.length < 3 ? new Error("temporary") : null };
      },
      async (delayMs) => { waits.push(delayMs); },
      [0, 750, 2_000, 5_000],
    );

    expect(delivered).toBe(true);
    expect(attempts).toHaveLength(3);
    expect(waits).toEqual([750, 2_000]);
  });

  it("stops after the configured retry budget", async () => {
    let attempts = 0;
    const delivered = await dispatchRealtimeOutboxWithRetry(
      async () => { attempts += 1; throw new Error("offline"); },
      async () => undefined,
      [0, 1, 2, 3],
    );

    expect(delivered).toBe(false);
    expect(attempts).toBe(4);
  });
});
