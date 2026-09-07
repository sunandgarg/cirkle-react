import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  subscribeToAuthChanges: vi.fn(),
}));
const httpMocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  refreshApiSession: vi.fn(),
}));

vi.mock("@/integrations/api/session", () => ({
  isSessionExpiring: () => false,
  readSession: sessionMocks.readSession,
  subscribeToAuthChanges: sessionMocks.subscribeToAuthChanges,
}));
vi.mock("@/integrations/api/http", () => ({
  apiRequest: httpMocks.apiRequest,
  refreshApiSession: httpMocks.refreshApiSession,
}));

type SentFrame = Record<string, any>;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    sockets.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  close(code?: number, reason?: string) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
  }
}

const sockets: FakeWebSocket[] = [];
const cleanups: Array<() => void> = [];
let subscribeAppSync: (
  channel: string,
  onEvent: (event: Record<string, unknown>) => void,
  onStatus?: (status: string) => void,
) => () => void;

const flushAsyncWork = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const frames = (socket: FakeWebSocket): SentFrame[] => socket.sent.map((value) => JSON.parse(value));
const subscriptionFrames = (socket: FakeWebSocket) => frames(socket).filter((frame) => frame.type === "subscribe");

const setDocumentHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
};

const connectSubscription = async (
  channel: string,
  onEvent = vi.fn(),
  onStatus = vi.fn(),
) => {
  const unsubscribe = subscribeAppSync(channel, onEvent, onStatus);
  cleanups.push(unsubscribe);
  await flushAsyncWork();
  const socket = sockets.at(-1);
  expect(socket).toBeDefined();
  socket!.open();
  expect(frames(socket!)).toContainEqual({ type: "connection_init" });
  socket!.receive({ type: "connection_ack", connectionTimeoutMs: 120_000 });
  await flushAsyncWork();
  const subscribe = subscriptionFrames(socket!)[0];
  expect(subscribe).toBeDefined();
  return { onEvent, onStatus, socket: socket!, subscribe, unsubscribe };
};

beforeAll(async () => {
  vi.stubEnv("VITE_CHAT_REALTIME_PROVIDER", "appsync");
  vi.stubEnv("VITE_APPSYNC_HTTP_ENDPOINT", "https://hzrd5pmdhvfobbzonf2hffeq5e.appsync-api.ap-south-1.amazonaws.com/event");
  vi.stubEnv("VITE_APPSYNC_REALTIME_ENDPOINT", "wss://hzrd5pmdhvfobbzonf2hffeq5e.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime");
  vi.stubGlobal("WebSocket", FakeWebSocket);
  ({ subscribeAppSync } = await import("@/lib/appsyncEvents"));
});

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  cleanups.length = 0;
  setDocumentHidden(false);
  sessionMocks.readSession.mockReturnValue({
    access_token: "signed-user-token",
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
  });
  httpMocks.refreshApiSession.mockResolvedValue(null);
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  setDocumentHidden(false);
  window.dispatchEvent(new Event("focus"));
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "visibilityState");
});

describe("AppSync Events browser client", () => {
  it("completes the AWS handshake, subscribes, and dispatches scalar and array event frames", async () => {
    const { onEvent, onStatus, socket, subscribe } = await connectSubscription(
      "/chat/11111111-1111-4111-8111-111111111111",
    );

    expect(socket.url).toBe("wss://hzrd5pmdhvfobbzonf2hffeq5e.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime");
    expect(socket.protocols).toEqual(expect.arrayContaining(["aws-appsync-event-ws"]));
    expect(subscribe).toMatchObject({
      type: "subscribe",
      channel: "/chat/11111111-1111-4111-8111-111111111111",
      authorization: {
        Authorization: "signed-user-token",
        host: "hzrd5pmdhvfobbzonf2hffeq5e.appsync-api.ap-south-1.amazonaws.com",
      },
    });

    socket.receive({ type: "subscribe_success", id: subscribe.id });
    const inserted = { schemaVersion: 1, eventType: "INSERT", new: { id: "message-1" } };
    const updated = { schemaVersion: 1, eventType: "UPDATE", new: { id: "message-1" } };
    socket.receive({ type: "data", id: subscribe.id, event: JSON.stringify(inserted) });
    socket.receive({ type: "data", id: subscribe.id, event: [JSON.stringify(updated), { eventType: "DELETE", old: { id: "message-1" } }] });

    expect(onStatus).toHaveBeenCalledWith("CONNECTING");
    expect(onStatus).toHaveBeenCalledWith("SUBSCRIBED");
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      inserted,
      updated,
      { eventType: "DELETE", old: { id: "message-1" } },
    ]);
  });

  it("does not retry a subscription rejected for authorization", async () => {
    const { onStatus, socket, subscribe } = await connectSubscription(
      "/inbox/11111111-1111-4111-8111-111111111111",
    );

    socket.receive({
      type: "subscribe_error",
      id: subscribe.id,
      errors: [{ errorType: "UnauthorizedException", message: "Unauthorized" }],
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onStatus).toHaveBeenCalledWith("CHANNEL_ERROR");
    expect(subscriptionFrames(socket)).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(socket.closeCalls).toContainEqual({ code: 1000, reason: "idle" });
  });

  it("retires fallback when valid data proves recovery after a broadcast error", async () => {
    const { onEvent, onStatus, socket, subscribe } = await connectSubscription(
      "/chat/11111111-1111-4111-8111-111111111111",
    );
    socket.receive({ type: "subscribe_success", id: subscribe.id });
    socket.receive({ type: "broadcast_error", id: subscribe.id, errors: [{ message: "one event failed" }] });
    socket.receive({ type: "data", id: subscribe.id, event: "not-json" });
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual([
      "CONNECTING", "SUBSCRIBED", "CHANNEL_ERROR",
    ]);

    const recovered = { schemaVersion: 1, eventType: "UPDATE", new: { id: "message-1" } };
    socket.receive({ type: "data", id: subscribe.id, event: JSON.stringify(recovered) });

    expect(onStatus.mock.calls.map(([status]) => status)).toEqual([
      "CONNECTING", "SUBSCRIBED", "CHANNEL_ERROR", "SUBSCRIBED",
    ]);
    expect(onEvent).toHaveBeenCalledWith(recovered);
    expect(subscriptionFrames(socket)).toHaveLength(1);
  });

  it("does not reconnect when AWS rejects connection authorization", async () => {
    const onStatus = vi.fn();
    const unsubscribe = subscribeAppSync(
      "/inbox/11111111-1111-4111-8111-111111111111",
      vi.fn(),
      onStatus,
    );
    cleanups.push(unsubscribe);
    await flushAsyncWork();
    const socket = sockets[0];
    socket.open();
    socket.receive({
      type: "connection_error",
      errors: [{ errorType: "UnauthorizedException", message: "Unauthorized" }],
    });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onStatus).toHaveBeenCalledWith("CHANNEL_ERROR");
    expect(sockets).toHaveLength(1);
  });

  it("closes immediately on blur and reconnects the retained subscription on focus", async () => {
    const { socket, subscribe } = await connectSubscription(
      "/chat/11111111-1111-4111-8111-111111111111",
    );
    socket.receive({ type: "subscribe_success", id: subscribe.id });

    window.dispatchEvent(new Event("blur"));
    expect(socket.closeCalls).toContainEqual({ code: 1000, reason: "idle" });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    window.dispatchEvent(new Event("focus"));
    await flushAsyncWork();
    expect(sockets).toHaveLength(2);
    const resumed = sockets[1];
    resumed.open();
    resumed.receive({ type: "connection_ack", connectionTimeoutMs: 120_000 });
    await flushAsyncWork();
    expect(subscriptionFrames(resumed)).toHaveLength(1);
    expect(subscriptionFrames(resumed)[0].id).toBe(subscribe.id);
  });

  it("closes immediately when hidden and reconnects only after visibility returns", async () => {
    const { socket } = await connectSubscription(
      "/chat/11111111-1111-4111-8111-111111111111",
    );

    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(socket.closeCalls).toContainEqual({ code: 1000, reason: "idle" });

    window.dispatchEvent(new Event("focus"));
    await flushAsyncWork();
    expect(sockets).toHaveLength(1);

    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flushAsyncWork();
    expect(sockets).toHaveLength(2);
  });

  it("closes when the last routed screen unmounts and stays offline beyond 30 seconds", async () => {
    const { socket, subscribe, unsubscribe } = await connectSubscription(
      "/forum/iit-all",
    );
    socket.receive({ type: "subscribe_success", id: subscribe.id });

    // React route cleanup removes the final listener synchronously. There is
    // deliberately no grace period that could accumulate AppSync connection
    // minutes while the member uses another page in Cirkle.
    unsubscribe();
    expect(frames(socket)).toContainEqual({ id: subscribe.id, type: "unsubscribe" });
    expect(socket.closeCalls).toContainEqual({ code: 1000, reason: "idle" });

    await vi.advanceTimersByTimeAsync(30_001);
    expect(sockets).toHaveLength(1);
  });
});
