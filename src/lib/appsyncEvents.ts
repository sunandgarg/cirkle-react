import { apiRequest, refreshApiSession } from "@/integrations/api/http";
import { isSessionExpiring, readSession, subscribeToAuthChanges } from "@/integrations/api/session";

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
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 300_000;
const MAX_SUBSCRIPTIONS = 50;
const MAX_SUBSCRIPTION_RETRIES = 6;
const APP_SYNC_CHANNEL = /^\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?)(?:\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?)){0,4}$/;

export const appSyncRealtimeEnabled = provider === "appsync" && Boolean(realtimeEndpoint && httpEndpoint);

const base64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

export const isValidClientAppSyncChannel = (channel: string): boolean => APP_SYNC_CHANNEL.test(channel);

export const appSyncKeepAliveTimeout = (value: unknown): number => {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 10_000 && timeout <= 10 * 60_000
    ? timeout
    : DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
};

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
  private readySocket: WebSocket | null = null;
  private listeners = new Map<string, Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempt = 0;
  private connecting: Promise<void> | null = null;
  private intentionallyClosedSockets = new WeakSet<WebSocket>();
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_TIMEOUT_MS;

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
      window.addEventListener("online", () => { if (this.listeners.size) this.ensureConnection(); });
      subscribeToAuthChanges((event) => {
        this.closeSocket();
        if (event !== "SIGNED_OUT" && this.listeners.size && !document.hidden) this.ensureConnection();
      });
    }
  }

  subscribe(channel: string, onEvent: Listener["onEvent"], onStatus?: Listener["onStatus"]) {
    if (!isValidClientAppSyncChannel(channel) || this.listeners.size >= MAX_SUBSCRIPTIONS) {
      onStatus?.("CHANNEL_ERROR");
      return () => undefined;
    }
    const id = crypto.randomUUID();
    this.listeners.set(id, { id, channel, onEvent, onStatus, retryAttempt: 0 });
    onStatus?.("CONNECTING");
    if (this.readySocket?.readyState === WebSocket.OPEN) {
      void this.sendSubscription(id).catch(() => this.scheduleSubscriptionRetry(id));
    } else this.ensureConnection();
    return () => {
      if (this.socket?.readyState === WebSocket.OPEN && this.readySocket === this.socket) {
        this.socket.send(JSON.stringify({ id, type: "unsubscribe" }));
      }
      const retryTimer = this.subscriptionRetryTimers.get(id);
      if (retryTimer) clearTimeout(retryTimer);
      this.subscriptionRetryTimers.delete(id);
      this.listeners.delete(id);
      if (!this.listeners.size) this.closeSocket();
    };
  }

  private async accessToken() {
    let session = readSession();
    if (session && isSessionExpiring(session, 45)) session = await refreshApiSession();
    if (!session?.access_token) throw new Error("Your session has expired");
    return session.access_token;
  }

  private scheduleTokenRefresh() {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = null;
    const session = readSession();
    if (!session?.expires_at) return;
    const delay = Math.max(1_000, session.expires_at * 1000 - Date.now() - 30_000);
    this.tokenRefreshTimer = setTimeout(() => {
      this.tokenRefreshTimer = null;
      void refreshApiSession().then((next) => {
        // A successful refresh emits TOKEN_REFRESHED and the auth listener
        // reconnects with the new JWT. On failure, stop using the old socket
        // before its token expires and let durable recovery take over.
        if (next) return;
        this.closeSocket();
        this.listeners.forEach((listener) => listener.onStatus?.("CHANNEL_ERROR"));
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async connect() {
    if (!appSyncRealtimeEnabled || typeof WebSocket === "undefined") throw new Error("AppSync is not configured");
    if (this.readySocket?.readyState === WebSocket.OPEN) return;
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
          if (this.socket !== socket) return;
          if (payload.type === "connection_ack") {
            clearTimeout(timeout);
            acknowledged = true;
            this.readySocket = socket;
            this.keepAliveTimeoutMs = appSyncKeepAliveTimeout(payload.connectionTimeoutMs);
            this.resetKeepAliveTimer(socket);
            this.reconnectAttempt = 0;
            resolve();
            return;
          }
          if (payload.type === "ka") {
            if (acknowledged) this.resetKeepAliveTimer(socket);
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
          if (this.socket === socket) {
            this.socket = null;
            this.readySocket = null;
            this.clearKeepAliveTimer();
          }
          const intentionallyClosed = this.intentionallyClosedSockets.delete(socket);
          if (!acknowledged) {
            if (intentionallyClosed) resolve();
            else reject(new Error("Realtime connection closed"));
          }
          // An intentional background/unmount close must not start the
          // compatibility fallback; foreground recovery queries the DB.
          if (!intentionallyClosed) {
            this.listeners.forEach((listener) => listener.onStatus?.("CLOSED"));
            if (this.listeners.size && (typeof document === "undefined" || !document.hidden)) this.scheduleReconnect();
          }
        };
      });
      if (this.readySocket?.readyState !== WebSocket.OPEN) {
        if (this.listeners.size && (typeof document === "undefined" || !document.hidden)) {
          throw new Error("Realtime connection closed before it became ready");
        }
        return;
      }
      await Promise.all([...this.listeners.keys()].map((id) => this.sendSubscription(id)));
      this.scheduleTokenRefresh();
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async sendSubscription(id: string) {
    const listener = this.listeners.get(id);
    if (!listener || !this.socket || this.readySocket !== this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const socket = this.socket;
    const token = await this.accessToken();
    // Refreshing an expiring JWT emits TOKEN_REFRESHED and intentionally
    // replaces the socket. Never send on the stale instance after the await.
    if (this.socket !== socket || this.readySocket !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
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
    if (message.type === "broadcast_error" && listener) {
      // The subscription remains registered after a single broadcast failure;
      // trigger durable recovery without sending a duplicate subscribe ID.
      listener.onStatus?.("CHANNEL_ERROR");
    }
    if ((message.type === "subscribe_error" || message.type === "error") && listener) {
      listener.onStatus?.("CHANNEL_ERROR");
      if (!this.isAuthorizationError(message)) this.scheduleSubscriptionRetry(listener.id);
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
    if (listener.retryAttempt >= MAX_SUBSCRIPTION_RETRIES) return;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(listener.retryAttempt++, 5)) + Math.random() * 750;
    const timer = setTimeout(() => {
      this.subscriptionRetryTimers.delete(id);
      if (!this.listeners.has(id) || (typeof document !== "undefined" && document.hidden)) return;
      if (this.socket?.readyState === WebSocket.OPEN && this.readySocket === this.socket) {
        void this.sendSubscription(id).catch(() => this.scheduleSubscriptionRetry(id));
      } else {
        void this.connect().catch(() => this.scheduleReconnect());
      }
    }, delay);
    this.subscriptionRetryTimers.set(id, timer);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.listeners.size || !readSession()) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++) + Math.random() * 500;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnection();
    }, delay);
  }

  private ensureConnection() {
    void this.connect().catch(() => {
      this.listeners.forEach((listener) => listener.onStatus?.("CHANNEL_ERROR"));
      this.scheduleReconnect();
    });
  }

  private isAuthorizationError(message: any): boolean {
    const errors = Array.isArray(message?.errors) ? message.errors : [];
    return errors.some((error: unknown) => {
      const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
      return /unauthori[sz]|access.?denied|forbidden/i.test(`${String(record.errorType || "")} ${String(record.message || "")}`);
    });
  }

  private clearKeepAliveTimer() {
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private resetKeepAliveTimer(socket: WebSocket) {
    this.clearKeepAliveTimer();
    this.keepAliveTimer = setTimeout(() => {
      this.keepAliveTimer = null;
      if (this.socket === socket && this.readySocket === socket) socket.close(4000, "keep-alive timeout");
    }, this.keepAliveTimeoutMs);
  }

  private closeSocket() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.subscriptionRetryTimers.forEach((timer) => clearTimeout(timer));
    this.subscriptionRetryTimers.clear();
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = null;
    this.clearKeepAliveTimer();
    const socket = this.socket;
    if (socket) {
      this.intentionallyClosedSockets.add(socket);
      socket.close(1000, "idle");
    }
    this.socket = null;
    this.readySocket = null;
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
    if (this.listeners.size) this.ensureConnection();
  }
}

const client = new AppSyncEventsClient();

export const subscribeAppSync = (channel: string, onEvent: Listener["onEvent"], onStatus?: Listener["onStatus"]) =>
  client.subscribe(channel, onEvent, onStatus);

export const getForumAppSyncChannels = async (scopeType: string, scopeKey: string) => {
  const { data, error } = await apiRequest<{ message_channel: string }>("rpc/get_appsync_forum_channels", {
    method: "POST",
    body: {
    p_scope_type: scopeType,
    p_scope_key: scopeKey,
    },
  });
  if (error) throw error;
  if (!data) throw new Error("AppSync forum channels are unavailable");
  return data;
};

export const chatAppSyncChannels = (roomId: string) => ({
  message_channel: `/chat/${roomId}`,
});

// Existing mutation call sites keep this hook, but outbox dispatch is owned by
// the Node process (enqueue, immediate drain and a 15-second retry loop).
// Browsers intentionally have no endpoint for forcing a drain.
export const requestRealtimeDispatch = (): void => undefined;
