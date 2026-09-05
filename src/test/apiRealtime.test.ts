import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeActivityController } from "@/hooks/useRealtimeActivity";

const realtimeMock = vi.hoisted(() => ({ socket: null as any, sockets: [] as any[] }));

vi.mock("socket.io-client", () => ({
  io: vi.fn((_origin?: unknown, options?: { auth?: Record<string, unknown> }) => {
    const handlers = new Map<string, Set<(...args: any[]) => void>>();
    const socket = {
      connected: true,
      auth: { ...(options?.auth || {}) } as Record<string, unknown>,
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
    realtimeMock.sockets.push(socket);
    return socket;
  }),
}));

const subscriptions = (socket: any) => socket.emitted.filter((entry: any) => entry.event === "realtime:subscribe");
const acknowledgeLatestSubscription = (socket: any) => subscriptions(socket).at(-1)?.args.at(-1)({ ok: true });

describe("API realtime lifecycle", () => {
  afterEach(async () => {
    const { resetRealtimeSocket } = await import("@/integrations/api/realtime");
    const { clearSession } = await import("@/integrations/api/session");
    resetRealtimeSocket();
    clearSession();
    realtimeMock.socket = null;
    realtimeMock.sockets.length = 0;
    vi.clearAllMocks();
  });

  it("waits for the server acknowledgement and restores bindings after reconnect and auth refresh", async () => {
    const { ApiRealtimeChannel, ApiRealtimeClient } = await import("@/integrations/api/realtime");
    const { clearSession, writeSession } = await import("@/integrations/api/session");
    const statuses: string[] = [];
    const channel = new ApiRealtimeChannel("forum:GLOBAL:IIT_ALL")
      .on("postgres_changes", { table: "posts", event: "*" }, vi.fn())
      .subscribe((status) => statuses.push(status));

    await Promise.resolve();
    const socket = realtimeMock.socket;
    const socketSubscriptions = () => subscriptions(socket);
    await vi.waitFor(() => expect(socketSubscriptions()).toHaveLength(1));
    expect(statuses).toEqual([]);

    socketSubscriptions()[0].args.at(-1)({ ok: true });
    expect(statuses).toEqual(["SUBSCRIBED"]);

    socket.autoAck = true;
    socket.disconnect();
    socket.connect();
    expect(socketSubscriptions()).toHaveLength(2);
    expect(statuses).toEqual(["SUBSCRIBED", "SUBSCRIBED"]);

    await new ApiRealtimeClient().setAuth("new-access-token");
    expect(socketSubscriptions()).toHaveLength(3);
    const reconnects = socket.connectCalls;
    await new ApiRealtimeClient().setAuth("new-access-token");
    expect(socket.connectCalls).toBe(reconnects);

    writeSession({ access_token: "refreshed-by-http", token_type: "bearer", user: { id: "member-one", app_metadata: {}, user_metadata: {} } }, "TOKEN_REFRESHED");
    await Promise.resolve();
    expect(socket.auth.token).toBe("refreshed-by-http");
    expect(socketSubscriptions()).toHaveLength(4);

    socket.disconnect();
    const reconnectsAfterExpiry = socket.connectCalls;
    writeSession({ access_token: "refreshed-after-expiry", token_type: "bearer", user: { id: "member-one", app_metadata: {}, user_metadata: {} } }, "TOKEN_REFRESHED");
    await Promise.resolve();
    expect(socket.connectCalls).toBe(reconnectsAfterExpiry + 1);
    expect(socket.auth.token).toBe("refreshed-after-expiry");
    expect(socketSubscriptions()).toHaveLength(5);

    clearSession(true);
    await Promise.resolve();
    expect(socket.disconnectCalls).toBeGreaterThanOrEqual(2);
    expect(statuses.at(-1)).toBe("CLOSED");
    await channel.unsubscribe();
  });

  it("keeps one shared transport until the final active channel unsubscribes", async () => {
    const { ApiRealtimeChannel } = await import("@/integrations/api/realtime");
    const first = new ApiRealtimeChannel("forum:GLOBAL:IIT_ALL").subscribe();
    await vi.waitFor(() => expect(realtimeMock.sockets).toHaveLength(1));
    const sharedSocket = realtimeMock.sockets[0];
    await vi.waitFor(() => expect(subscriptions(sharedSocket)).toHaveLength(1));
    acknowledgeLatestSubscription(sharedSocket);
    sharedSocket.autoAck = true;

    const second = new ApiRealtimeChannel("chat:room-one").subscribe();
    await vi.waitFor(() => expect(subscriptions(sharedSocket)).toHaveLength(2));
    expect(realtimeMock.sockets).toHaveLength(1);

    await first.unsubscribe();
    expect(sharedSocket.disconnectCalls).toBe(0);
    expect(sharedSocket.connected).toBe(true);

    await second.unsubscribe();
    expect(sharedSocket.disconnectCalls).toBe(1);
    expect(sharedSocket.connected).toBe(false);
  });

  it("prepares refreshed auth without opening an idle transport", async () => {
    const { ApiRealtimeChannel, ApiRealtimeClient } = await import("@/integrations/api/realtime");
    await new ApiRealtimeClient().setAuth("prepared-access-token");
    expect(realtimeMock.sockets).toHaveLength(0);

    const channel = new ApiRealtimeChannel("chat:room-one").subscribe();
    await vi.waitFor(() => expect(realtimeMock.sockets).toHaveLength(1));
    expect(realtimeMock.sockets[0].auth.token).toBe("prepared-access-token");
    await channel.unsubscribe();
  });

  it("disconnects on hidden cleanup, then creates a fresh transport and recovers on visibility", async () => {
    const { ApiRealtimeChannel } = await import("@/integrations/api/realtime");
    const recovered = vi.fn();
    const subscribe = () => new ApiRealtimeChannel("forum:GLOBAL:IIT_ALL").subscribe((status) => {
      if (status === "SUBSCRIBED") recovered();
    });
    let channel = subscribe();
    await vi.waitFor(() => expect(realtimeMock.sockets).toHaveLength(1));
    const firstSocket = realtimeMock.sockets[0];
    await vi.waitFor(() => expect(subscriptions(firstSocket)).toHaveLength(1));
    acknowledgeLatestSubscription(firstSocket);
    recovered.mockClear();

    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), {
      hidden: false,
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const controller = createRealtimeActivityController({
      windowTarget,
      documentTarget,
      onActiveChange(active) {
        if (!active) void channel.unsubscribe();
        else channel = subscribe();
      },
    });

    documentTarget.hidden = true;
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(firstSocket.disconnectCalls).toBe(1);
    expect(firstSocket.connected).toBe(false);

    documentTarget.hidden = false;
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(realtimeMock.sockets).toHaveLength(2));
    const resumedSocket = realtimeMock.sockets[1];
    expect(resumedSocket).not.toBe(firstSocket);
    await vi.waitFor(() => expect(subscriptions(resumedSocket)).toHaveLength(1));
    acknowledgeLatestSubscription(resumedSocket);
    expect(recovered).toHaveBeenCalledTimes(1);

    controller.dispose();
    await channel.unsubscribe();
  });
});
