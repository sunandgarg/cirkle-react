import { io } from "socket.io-client";
import { API_BASE_URL, API_ORIGIN } from "./http";
import { readSession, subscribeToAuthChanges } from "./session";

type RealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";
type RealtimeCallback = (payload: any) => void;

type SocketLike = {
  connected?: boolean;
  auth?: Record<string, unknown>;
  connect?: () => void;
  disconnect?: () => void;
  emit: (event: string, ...args: any[]) => unknown;
  on: (event: string, callback: (...args: any[]) => void) => SocketLike;
  off?: (event: string, callback?: (...args: any[]) => void) => SocketLike;
};

let socket: SocketLike | null = null;
let socketAuthToken = "";
const activeChannels = new Set<ApiRealtimeChannel>();

const disconnectSocketWhenIdle = (): void => {
  if (activeChannels.size > 0 || !socket) return;
  const idleSocket = socket;
  // Clear the shared reference before disconnecting because Socket.IO emits
  // `disconnect` synchronously and a foreground resubscribe must create a new
  // transport instead of reusing this intentionally closed one.
  socket = null;
  idleSocket.disconnect?.();
};

const applySocketAuth = (active: SocketLike, token: string): void => {
  if (active.auth?.token === token) return;
  active.auth = { ...(active.auth || {}), token };
  if (active.connected) {
    // Socket.IO authenticates during the handshake. Reconnecting also causes
    // every active channel to re-register through its connect listener.
    active.disconnect?.();
  }
  // A server-initiated disconnect at access-token expiry disables Socket.IO's
  // automatic reconnection. A newly refreshed token must explicitly restore it.
  if (token) active.connect?.();
};

const socketPath = (): string => {
  try {
    return `${new URL(API_BASE_URL, typeof window !== "undefined" ? window.location.origin : "http://localhost").pathname.replace(/\/+$/, "")}/socket.io`;
  } catch {
    return "/api/socket.io";
  }
};

const getSocket = async (): Promise<SocketLike | null> => {
  if (socket) return socket;
  const accessToken = socketAuthToken || readSession()?.access_token;
  socket = io(API_ORIGIN || undefined, {
    path: socketPath(),
    withCredentials: true,
    transports: ["websocket", "polling"],
    auth: accessToken ? { token: accessToken } : {},
  }) as unknown as SocketLike;
  return socket;
};

type ChannelHandler = { type: string; filter: Record<string, unknown>; callback: RealtimeCallback };

export class ApiRealtimeChannel {
  private readonly handlers: ChannelHandler[] = [];
  private statusCallback?: (status: RealtimeStatus, error?: Error) => void;
  private activeSocket: SocketLike | null = null;
  private subscribed = false;
  private serverSubscribed = false;
  private subscriptionPending = false;
  private subscriptionAttempt = 0;
  private readySignalled = false;

  constructor(
    readonly topic: string,
    private readonly config: Record<string, unknown> = {},
  ) {}

  on(type: string, filter: Record<string, unknown>, callback: RealtimeCallback): this {
    this.handlers.push({ type, filter: filter || {}, callback });
    return this;
  }

  subscribe(callback?: (status: RealtimeStatus, error?: Error) => void): this {
    this.statusCallback = callback;
    activeChannels.add(this);
    void this.connect();
    return this;
  }

  private readonly handleConnect = (): void => {
    this.serverSubscribed = false;
    this.subscriptionPending = false;
    this.readySignalled = false;
    void this.subscribeOnServer();
  };

  private readonly handleDisconnect = (): void => {
    this.subscriptionAttempt += 1;
    this.serverSubscribed = false;
    this.subscriptionPending = false;
    this.readySignalled = false;
  };

  private readonly handleConnectError = (error: Error): void => {
    this.statusCallback?.("CHANNEL_ERROR", error);
  };

  private readonly dispatch = (envelope: any): void => {
    const message = envelope && typeof envelope === "object" ? envelope : { payload: envelope };
    if (message.channel && message.channel !== this.topic && message.topic !== this.topic) return;
    const messageType = String(message.type || message.kind || "broadcast");
    const event = String(message.event || message.payload?.event || message.eventType || "*");

    this.handlers.forEach((handler) => {
      if (handler.type !== messageType && !(handler.type === "broadcast" && !message.type)) return;
      const expectedEvent = String(handler.filter.event || "*");
      if (expectedEvent !== "*" && expectedEvent !== event) return;
      handler.callback(message.payload && messageType === "postgres_changes" && !message.new && !message.old
        ? message.payload
        : message);
    });
  };

  private async connect(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;
    const active = await getSocket();
    // A visibility/page lifecycle cleanup can unsubscribe while the async
    // continuation above is queued. Do not attach a stale channel afterward.
    if (!this.subscribed || !activeChannels.has(this)) {
      disconnectSocketWhenIdle();
      return;
    }
    if (!active) {
      this.statusCallback?.("CHANNEL_ERROR", new Error("socket.io-client is unavailable"));
      return;
    }
    this.activeSocket = active;
    active.on("connect", this.handleConnect);
    active.on("disconnect", this.handleDisconnect);
    active.on("connect_error", this.handleConnectError);
    active.on("realtime:event", this.dispatch);
    active.on("realtime", this.dispatch);
    active.on(`realtime:${this.topic}`, this.dispatch);
    if (active.connected) await this.subscribeOnServer();
  }

  private async subscribeOnServer(): Promise<void> {
    const active = this.activeSocket;
    if (!this.subscribed || !active?.connected || this.serverSubscribed || this.subscriptionPending) return;
    this.subscriptionPending = true;
    const attempt = ++this.subscriptionAttempt;
    const timeout = globalThis.setTimeout(() => {
      if (attempt !== this.subscriptionAttempt || !this.subscriptionPending) return;
      this.subscriptionPending = false;
      this.statusCallback?.("TIMED_OUT", new Error("Realtime subscription acknowledgement timed out"));
    }, 10_000);

    active.emit("realtime:subscribe", {
      channel: this.topic,
      config: this.config,
      bindings: this.handlers.map(({ type, filter }) => ({ type, filter })),
    }, (ack?: { ok?: boolean; error?: string }) => {
      if (attempt !== this.subscriptionAttempt) return;
      globalThis.clearTimeout(timeout);
      this.subscriptionPending = false;
      if (!this.subscribed || !active.connected) return;
      if (ack?.ok !== true) {
        this.serverSubscribed = false;
        this.statusCallback?.("CHANNEL_ERROR", new Error(ack?.error || "Realtime subscription failed"));
        return;
      }
      this.serverSubscribed = true;
      if (!this.readySignalled) {
        this.readySignalled = true;
        this.statusCallback?.("SUBSCRIBED");
      }
    });
  }

  private async emit(type: string, message: Record<string, unknown>): Promise<"ok" | "error" | "timed out"> {
    const active = this.activeSocket || await getSocket();
    if (!active) return "error";
    return new Promise((resolve) => {
      let settled = false;
      const finish = (status: "ok" | "error" | "timed out") => {
        if (settled) return;
        settled = true;
        resolve(status);
      };
      active.emit(type, { channel: this.topic, ...message }, (ack?: { ok?: boolean; status?: string }) => {
        finish(ack?.ok === false || ack?.status === "error" ? "error" : "ok");
      });
      globalThis.setTimeout(() => finish("timed out"), 5000);
    });
  }

  send(message: { type: string; event: string; payload: unknown }): Promise<"ok" | "error" | "timed out"> {
    return this.emit("realtime:send", message);
  }

  track(payload: Record<string, unknown>): Promise<"ok" | "error" | "timed out"> {
    return this.emit("realtime:track", { payload });
  }

  presenceState(): Record<string, unknown[]> {
    return {};
  }

  async unsubscribe(): Promise<"ok"> {
    this.subscribed = false;
    activeChannels.delete(this);
    this.subscriptionAttempt += 1;
    this.subscriptionPending = false;
    this.serverSubscribed = false;
    this.readySignalled = false;
    if (this.activeSocket) {
      if (this.activeSocket.connected) this.activeSocket.emit("realtime:unsubscribe", { channel: this.topic });
      this.activeSocket.off?.("connect", this.handleConnect);
      this.activeSocket.off?.("disconnect", this.handleDisconnect);
      this.activeSocket.off?.("connect_error", this.handleConnectError);
      this.activeSocket.off?.("realtime:event", this.dispatch);
      this.activeSocket.off?.("realtime", this.dispatch);
      this.activeSocket.off?.(`realtime:${this.topic}`, this.dispatch);
    }
    this.activeSocket = null;
    disconnectSocketWhenIdle();
    this.statusCallback?.("CLOSED");
    return "ok";
  }

  resetSocket(): void {
    this.subscribed = false;
    activeChannels.delete(this);
    this.handleDisconnect();
    this.activeSocket?.off?.("connect", this.handleConnect);
    this.activeSocket?.off?.("disconnect", this.handleDisconnect);
    this.activeSocket?.off?.("connect_error", this.handleConnectError);
    this.activeSocket?.off?.("realtime:event", this.dispatch);
    this.activeSocket?.off?.("realtime", this.dispatch);
    this.activeSocket?.off?.(`realtime:${this.topic}`, this.dispatch);
    this.activeSocket = null;
    this.statusCallback?.("CLOSED");
  }
}

export class ApiRealtimeClient {
  async setAuth(token?: string): Promise<void> {
    const nextToken = token || readSession()?.access_token || "";
    socketAuthToken = nextToken;
    // Updating auth must not create an otherwise idle connection. A channel
    // subscription will open the transport with this prepared token.
    if (socket) applySocketAuth(socket, nextToken);
  }
}


export const resetRealtimeSocket = (): void => {
  activeChannels.forEach((channel) => channel.resetSocket());
  socket?.disconnect?.();
  socket = null;
  socketAuthToken = "";
};

subscribeToAuthChanges((event, session) => {
  if (event === "SIGNED_OUT") {
    resetRealtimeSocket();
    return;
  }
  if (session?.access_token) {
    socketAuthToken = session.access_token;
    if (socket) applySocketAuth(socket, session.access_token);
  }
});
