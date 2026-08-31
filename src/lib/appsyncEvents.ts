import { supabase } from "@/integrations/supabase/client";

export type AppSyncStatus = "CONNECTING" | "SUBSCRIBED" | "CHANNEL_ERROR" | "CLOSED";
export type AppSyncEvent = Record<string, unknown>;

type Listener = {
  id: string;
  channel: string;
  onEvent: (event: AppSyncEvent) => void;
  onStatus?: (status: AppSyncStatus) => void;
  retryAttempt: number;
};

const provider = import.meta.env.VITE_CHAT_REALTIME_PROVIDER;
const realtimeEndpoint = import.meta.env.VITE_APPSYNC_REALTIME_ENDPOINT;
const httpEndpoint = import.meta.env.VITE_APPSYNC_HTTP_ENDPOINT;
const BACKGROUND_IDLE_MS = 30_000;
const DISPATCH_RETRY_DELAYS_MS = [0, 750, 2_000, 5_000] as const;

export const appSyncRealtimeEnabled = provider === "appsync" && Boolean(realtimeEndpoint && httpEndpoint);

const base64Url = (value: string) => btoa(unescape(encodeURIComponent(value)))
  .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export const buildAppSyncAuthorization = (endpoint: string, token: string) => ({
  Authorization: token,
  host: new URL(endpoint).host,
});

export const getAppSyncEventFrames = (message: { event?: unknown; events?: unknown }) => {
  const value = message.event ?? message.events;
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

class AppSyncEventsClient {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempt = 0;
  private connecting: Promise<void> | null = null;
  private intentionallyClosedSockets = new WeakSet<WebSocket>();

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.scheduleBackgroundClose();
        else this.resumeForeground();
      });
      // Mobile browsers can freeze JavaScript as soon as the page is moved to
      // the background. Close synchronously for lifecycle events where a
      // delayed timer is not guaranteed to run. A normal hidden tab still gets
      // the 30-second grace period above.
      document.addEventListener("freeze", () => this.closeSocket());
      window.addEventListener("pagehide", () => this.closeSocket());
      window.addEventListener("pageshow", () => this.resumeForeground());
      window.addEventListener("online", () => { if (this.listeners.size) void this.connect(); });
    }
  }

  subscribe(channel: string, onEvent: Listener["onEvent"], onStatus?: Listener["onStatus"]) {
    const id = crypto.randomUUID();
    this.listeners.set(id, { id, channel, onEvent, onStatus, retryAttempt: 0 });
    onStatus?.("CONNECTING");
    if (this.socket?.readyState === WebSocket.OPEN) void this.sendSubscription(id);
    else void this.connect().catch(() => onStatus?.("CHANNEL_ERROR"));
    return () => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id, type: "unsubscribe" }));
      const retryTimer = this.subscriptionRetryTimers.get(id);
      if (retryTimer) clearTimeout(retryTimer);
      this.subscriptionRetryTimers.delete(id);
      this.listeners.delete(id);
      if (!this.listeners.size) this.closeSocket();
    };
  }

  async publish(channel: string, event: AppSyncEvent) {
    const token = await this.accessToken();
    const response = await fetch(httpEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: token },
      body: JSON.stringify({ channel, events: [JSON.stringify(event)] }),
    });
    if (!response.ok) throw new Error(`Live update failed (${response.status})`);
  }

  private async accessToken() {
    const { data, error } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (error || !token) throw error || new Error("Your session has expired");
    return token;
  }

  private async connect() {
    if (!appSyncRealtimeEnabled || typeof WebSocket === "undefined") throw new Error("AppSync is not configured");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const token = await this.accessToken();
      // AppSync validates the WebSocket handshake against the HTTP endpoint
      // host, even though the socket itself connects to the realtime domain.
      // Supplying the realtime host causes AWS to reject the handshake before
      // the Lambda authorizer is invoked.
      const header = base64Url(JSON.stringify(buildAppSyncAuthorization(httpEndpoint, token)));
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(realtimeEndpoint, ["aws-appsync-event-ws", `header-${header}`]);
        this.socket = socket;
        let acknowledged = false;
        const timeout = setTimeout(() => { socket.close(); reject(new Error("Realtime connection timed out")); }, 10_000);
        socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
        socket.onmessage = async (message) => {
          let payload: any;
          try {
            const raw = typeof message.data === "string"
              ? message.data
              : message.data instanceof Blob
                ? await message.data.text()
                : new TextDecoder().decode(message.data as ArrayBuffer);
            payload = JSON.parse(raw);
          } catch { return; }
          if (payload.type === "connection_ack") {
            clearTimeout(timeout);
            acknowledged = true;
            this.reconnectAttempt = 0;
            resolve();
            return;
          }
          if (!acknowledged && (payload.type === "connection_error" || payload.type === "error")) {
            clearTimeout(timeout);
            socket.close();
            reject(new Error("Realtime connection was rejected"));
            return;
          }
          this.handleMessage(payload);
        };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error("Realtime connection failed")); };
        socket.onclose = () => {
          clearTimeout(timeout);
          if (this.socket === socket) this.socket = null;
          const intentionallyClosed = this.intentionallyClosedSockets.delete(socket);
          if (!acknowledged) {
            if (intentionallyClosed) resolve();
            else reject(new Error("Realtime connection closed"));
          }
          // An intentional background/unmount close must not start the
          // Supabase realtime fallback; foreground recovery queries the DB.
          if (!intentionallyClosed) {
            this.listeners.forEach((listener) => listener.onStatus?.("CLOSED"));
            if (this.listeners.size && (typeof document === "undefined" || !document.hidden)) this.scheduleReconnect();
          }
        };
      });
      await Promise.all([...this.listeners.keys()].map((id) => this.sendSubscription(id)));
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async sendSubscription(id: string) {
    const listener = this.listeners.get(id);
    if (!listener || this.socket?.readyState !== WebSocket.OPEN) return;
    const token = await this.accessToken();
    this.socket.send(JSON.stringify({
      id,
      type: "subscribe",
      channel: listener.channel,
      authorization: buildAppSyncAuthorization(httpEndpoint, token),
    }));
  }

  private handleMessage(message: any) {
    const listener = message.id ? this.listeners.get(message.id) : null;
    if (message.type === "subscribe_success" && listener) {
      listener.retryAttempt = 0;
      const retryTimer = this.subscriptionRetryTimers.get(listener.id);
      if (retryTimer) clearTimeout(retryTimer);
      this.subscriptionRetryTimers.delete(listener.id);
      listener.onStatus?.("SUBSCRIBED");
    }
    if ((message.type === "subscribe_error" || message.type === "error") && listener) {
      listener.onStatus?.("CHANNEL_ERROR");
      this.scheduleSubscriptionRetry(listener.id);
    }
    if (message.type !== "data" || !listener) return;
    // HTTP-published AppSync Events currently arrive as one string in `event`,
    // while some SDK/protocol examples use arrays. Accept both wire shapes.
    const events = getAppSyncEventFrames(message);
    events.forEach((raw: unknown) => {
      try { listener.onEvent(typeof raw === "string" ? JSON.parse(raw) : raw as AppSyncEvent); }
      catch { /* Ignore malformed third-party realtime payloads; durable recovery remains authoritative. */ }
    });
  }

  private scheduleSubscriptionRetry(id: string) {
    const listener = this.listeners.get(id);
    if (!listener || this.subscriptionRetryTimers.has(id)) return;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(listener.retryAttempt++, 5)) + Math.random() * 750;
    const timer = setTimeout(() => {
      this.subscriptionRetryTimers.delete(id);
      if (!this.listeners.has(id) || (typeof document !== "undefined" && document.hidden)) return;
      if (this.socket?.readyState === WebSocket.OPEN) {
        void this.sendSubscription(id).catch(() => this.scheduleSubscriptionRetry(id));
      } else {
        void this.connect().catch(() => this.scheduleReconnect());
      }
    }, delay);
    this.subscriptionRetryTimers.set(id, timer);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++) + Math.random() * 500;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private closeSocket() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.subscriptionRetryTimers.forEach((timer) => clearTimeout(timer));
    this.subscriptionRetryTimers.clear();
    const socket = this.socket;
    if (socket) {
      this.intentionallyClosedSockets.add(socket);
      socket.close(1000, "idle");
    }
    this.socket = null;
  }

  private scheduleBackgroundClose() {
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = setTimeout(() => {
      this.hiddenTimer = null;
      this.closeSocket();
    }, BACKGROUND_IDLE_MS);
  }

  private resumeForeground() {
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.listeners.size) void this.connect();
  }
}

const client = new AppSyncEventsClient();

export const subscribeAppSync = (channel: string, onEvent: Listener["onEvent"], onStatus?: Listener["onStatus"]) =>
  client.subscribe(channel, onEvent, onStatus);

export const publishAppSync = (channel: string, event: AppSyncEvent) => client.publish(channel, event);

export const getForumAppSyncChannels = async (scopeType: string, scopeKey: string) => {
  const { data, error } = await (supabase as any).rpc("get_appsync_forum_channels", {
    p_scope_type: scopeType,
    p_scope_key: scopeKey,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as { message_channel: string; typing_channel: string; presence_channel: string };
};

export const chatAppSyncChannels = (roomId: string) => ({
  message_channel: `/chat/${roomId}`,
  typing_channel: `/chat-typing/${roomId}`,
  presence_channel: `/chat-presence/${roomId}`,
});

type DispatchResult = { error: unknown };
type DispatchInvoke = () => Promise<DispatchResult>;
type DispatchWait = (delayMs: number) => Promise<void>;

const waitForDispatchRetry: DispatchWait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export const dispatchRealtimeOutboxWithRetry = async (
  invoke: DispatchInvoke,
  wait: DispatchWait = waitForDispatchRetry,
  retryDelays: readonly number[] = DISPATCH_RETRY_DELAYS_MS,
) => {
  for (const delayMs of retryDelays) {
    if (delayMs) await wait(delayMs);
    try {
      const { error } = await invoke();
      if (!error) return true;
    } catch {
      // A later bounded attempt handles transient network and edge failures.
    }
  }
  return false;
};

let dispatchInFlight: Promise<void> | null = null;
let dispatchRequested = false;

export const requestRealtimeDispatch = () => {
  if (!appSyncRealtimeEnabled) return;
  dispatchRequested = true;
  if (dispatchInFlight) return;
  dispatchInFlight = (async () => {
    do {
      dispatchRequested = false;
      await dispatchRealtimeOutboxWithRetry(
        () => supabase.functions.invoke("dispatch-realtime-outbox", { body: {} }),
      );
      // A message persisted while a dispatch was already running needs one
      // additional drain. Coalescing avoids a request storm during bursts.
    } while (dispatchRequested);
  })().finally(() => { dispatchInFlight = null; });
};
