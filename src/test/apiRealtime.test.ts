import { describe, expect, it, vi } from "vitest";

const realtimeMock = vi.hoisted(() => ({ socket: null as any }));

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => {
    const handlers = new Map<string, Set<(...args: any[]) => void>>();
    const socket = {
      connected: true,
      auth: {} as Record<string, unknown>,
      autoAck: false,
      connectCalls: 0,
      disconnectCalls: 0,
      emitted: [] as Array<{ event: string; args: any[] }>,
      on(event: string, callback: (...args: any[]) => void) {
        const listeners = handlers.get(event) ?? new Set();
        listeners.add(callback);
        handlers.set(event, listeners);
        return socket;
      },
      off(event: string, callback?: (...args: any[]) => void) {
        if (!callback) handlers.delete(event);
        else handlers.get(event)?.delete(callback);
        return socket;
      },
      emit(event: string, ...args: any[]) {
        socket.emitted.push({ event, args });
        const ack = args.at(-1);
        if (event === "realtime:subscribe" && socket.autoAck && typeof ack === "function") ack({ ok: true });
        return socket;
      },
      disconnect() {
        socket.disconnectCalls += 1;
        if (socket.connected) {
          socket.connected = false;
          handlers.get("disconnect")?.forEach((listener) => listener("io client disconnect"));
        }
      },
      connect() {
        socket.connectCalls += 1;
        if (!socket.connected) {
          socket.connected = true;
          handlers.get("connect")?.forEach((listener) => listener());
        }
      },
    };
    realtimeMock.socket = socket;
    return socket;
  }),
}));

describe("API realtime lifecycle", () => {
  it("waits for the server acknowledgement and restores bindings after reconnect and auth refresh", async () => {
    const { ApiRealtimeChannel, ApiRealtimeClient } = await import("@/integrations/api/realtime");
    const { clearSession, writeSession } = await import("@/integrations/api/session");
    const statuses: string[] = [];
    const channel = new ApiRealtimeChannel("forum:GLOBAL:IIT_ALL")
      .on("postgres_changes", { table: "posts", event: "*" }, vi.fn())
      .subscribe((status) => statuses.push(status));

    await Promise.resolve();
    const socket = realtimeMock.socket;
    const subscriptions = () => socket.emitted.filter((entry: any) => entry.event === "realtime:subscribe");
    await vi.waitFor(() => expect(subscriptions()).toHaveLength(1));
    expect(statuses).toEqual([]);

    subscriptions()[0].args.at(-1)({ ok: true });
    expect(statuses).toEqual(["SUBSCRIBED"]);

    socket.autoAck = true;
    socket.disconnect();
    socket.connect();
    expect(subscriptions()).toHaveLength(2);
    expect(statuses).toEqual(["SUBSCRIBED", "SUBSCRIBED"]);

    await new ApiRealtimeClient().setAuth("new-access-token");
    expect(subscriptions()).toHaveLength(3);
    const reconnects = socket.connectCalls;
    await new ApiRealtimeClient().setAuth("new-access-token");
    expect(socket.connectCalls).toBe(reconnects);

    writeSession({ access_token: "refreshed-by-http", token_type: "bearer", user: { id: "member-one", app_metadata: {}, user_metadata: {} } }, "TOKEN_REFRESHED");
    await Promise.resolve();
    expect(socket.auth.token).toBe("refreshed-by-http");
    expect(subscriptions()).toHaveLength(4);

    socket.disconnect();
    const reconnectsAfterExpiry = socket.connectCalls;
    writeSession({ access_token: "refreshed-after-expiry", token_type: "bearer", user: { id: "member-one", app_metadata: {}, user_metadata: {} } }, "TOKEN_REFRESHED");
    await Promise.resolve();
    expect(socket.connectCalls).toBe(reconnectsAfterExpiry + 1);
    expect(socket.auth.token).toBe("refreshed-after-expiry");
    expect(subscriptions()).toHaveLength(5);

    clearSession(true);
    await Promise.resolve();
    expect(socket.disconnectCalls).toBeGreaterThanOrEqual(2);
    expect(statuses.at(-1)).toBe("CLOSED");
    await channel.unsubscribe();
  });
});
