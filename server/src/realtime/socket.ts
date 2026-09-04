import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { verifyAccessToken } from "../security/tokens.js";
import type { AuthUser } from "../types.js";
import { realtimeEvents, type DbChangeEvent } from "./events.js";
import { canUseForumScope } from "../security/forumScope.js";

export interface Binding { type?: string; filter?: Record<string, unknown> }
export interface Subscription { channel: string; bindings: Binding[] }
type AuthedSocket = Socket & { data: { auth: AuthUser; accessExpiresAt: number; subscriptions?: Map<string, Subscription>; presence?: Map<string, Record<string, unknown>> } };

export const accessTokenRemainingMs = (expiresAt: number, now = Date.now()): number => Math.max(0, expiresAt - now);

function channelUserId(channel: string): string | undefined {
  const uuid = channel.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
  for (const prefix of ["member-profile:", "connections-", "notifications-realtime-", "direct-message-connections-", "direct-message-sidebar-"]) {
    if (channel.startsWith(prefix)) return uuid;
  }
  return undefined;
}

function channelRoomId(channel: string): string | undefined {
  if (channel.startsWith("chat:")) return channel.slice(5);
  if (channel.startsWith("room-")) return channel.slice(5);
  return undefined;
}

async function canSubscribe(socket: AuthedSocket, channel: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9:_|.-]{1,300}$/.test(channel)) return false;
  const requestedUser = channelUserId(channel);
  if (requestedUser) return requestedUser === socket.data.auth.id || socket.data.auth.role === "admin" || socket.data.auth.role === "owner";
  const roomId = channelRoomId(channel);
  if (roomId) {
    const membership = await prisma.legacyRecord.findFirst({ where: {
      table_name: "chat_members",
      owner_id: socket.data.auth.id,
      data: { path: "$.room_id", equals: roomId },
    }, select: { id: true } });
    return !!membership;
  }
  if (channel.startsWith("forum-thread:") || channel.startsWith("forum-thread-pg:")) {
    const postId = channel.split(":").at(-1) ?? channel.split("forum-thread-pg:")[1];
    const post = postId ? await prisma.post.findUnique({ where: { id: postId } }) : null;
    return !!post && !post.deleted_at && !post.is_deleted_for_everyone
      && (post.author_id === socket.data.auth.id || await canUseForumScope(socket.data.auth.id, socket.data.auth.is_verified, socket.data.auth.role, post.scope_type, post.scope_key));
  }
  const directScope = channel.match(/^forum:([A-Z_]+):(.+)$/);
  const fallbackScope = channel.match(/^(?:forum-pg-|typing-)([A-Z_]+)-(.+)$/);
  const scope = directScope ?? fallbackScope;
  if (scope) return canUseForumScope(socket.data.auth.id, socket.data.auth.is_verified, socket.data.auth.role, scope[1]!, scope[2]!);
  return false;
}

function rowMatchesFilter(row: Record<string, unknown>, raw: unknown): boolean {
  if (typeof raw !== "string" || !raw) return true;
  const match = raw.match(/^([a-z][a-z0-9_]*)=(eq|neq)\.(.*)$/);
  if (!match) return false;
  return match[2] === "eq" ? String(row[match[1]!]) === match[3] : String(row[match[1]!]) !== match[3];
}

export function topicMatches(channel: string, change: DbChangeEvent): boolean {
  const row = change.row;
  if (change.room === channel) return true;
  if (channel.startsWith("forum:")) {
    const [, type, ...key] = channel.split(":");
    return change.table === "posts" && row.scope_type === type && row.scope_key === key.join(":");
  }
  if (channel.startsWith("forum-pg-")) {
    const suffix = channel.slice("forum-pg-".length);
    return change.table === "posts" && suffix === `${row.scope_type}-${row.scope_key}`;
  }
  if (channel.startsWith("forum-thread:")) return change.table === "posts" && (row.reply_to_id === channel.slice("forum-thread:".length) || row.id === channel.slice("forum-thread:".length));
  if (channel.startsWith("forum-thread-pg:")) return change.table === "posts" && row.reply_to_id === channel.slice("forum-thread-pg:".length);
  const roomId = channelRoomId(channel);
  if (roomId) return (change.table === "messages" || change.table === "chat_members") && row.room_id === roomId;
  const userId = channelUserId(channel);
  if (userId) return change.audience_ids?.includes(userId) === true || row.user_id === userId || row.author_id === userId || row.requester_id === userId || row.receiver_id === userId;
  return false;
}

export function bindingMatches(subscription: Subscription, change: DbChangeEvent): boolean {
  if (!topicMatches(subscription.channel, change)) return false;
  const postgres = subscription.bindings.filter((binding) => binding.type === "postgres_changes");
  if (!postgres.length) return true;
  return postgres.some((binding) => {
    const filter = binding.filter ?? {};
    return (!filter.table || filter.table === change.table)
      && (!filter.event || filter.event === "*" || filter.event === change.event)
      && rowMatchesFilter(change.row, filter.filter);
  });
}

export function envelopeForChange(subscription: Subscription, change: DbChangeEvent) {
  const channel = subscription.channel;
  const deleted = change.event === "DELETE";
  const postgres = subscription.bindings.some((binding) => binding.type === "postgres_changes");
  if (!postgres) return {
    channel,
    topic: channel,
    type: "broadcast",
    event: change.event,
    payload: { event: change.event, record: deleted ? undefined : change.row, old_record: deleted ? change.row : undefined },
  };
  return {
    channel,
    topic: channel,
    type: "postgres_changes",
    event: change.event,
    payload: {
      schema: "public",
      table: change.table,
      eventType: change.event,
      commit_timestamp: new Date().toISOString(),
      new: deleted ? {} : change.row,
      old: deleted ? change.row : {},
    },
  };
}

function emitEnvelope(socket: Socket, channel: string, payload: Record<string, unknown>): void {
  socket.emit("realtime:event", payload);
}

export function attachSocketServer(server: HttpServer): Server {
  const io = new Server(server, { path: "/api/socket.io", cors: { origin: config.corsOrigins, credentials: true }, maxHttpBufferSize: 256_000 });
  io.use(async (rawSocket, next) => {
    try {
      const token = typeof rawSocket.handshake.auth.token === "string" ? rawSocket.handshake.auth.token : rawSocket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!token) throw new Error("missing token");
      const payload = verifyAccessToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { profile: true } });
      if (!user || user.status !== "active") throw new Error("account unavailable");
      rawSocket.data.auth = { id: user.id, email: user.email, role: user.role as AuthUser["role"], community_id: user.profile?.community_id ?? config.DEFAULT_COMMUNITY_ID, is_verified: user.profile?.is_verified ?? false };
      rawSocket.data.accessExpiresAt = Number(payload.exp ?? 0) * 1000;
      if (!accessTokenRemainingMs(rawSocket.data.accessExpiresAt)) throw new Error("access token expired");
      next();
    } catch { next(new Error("unauthorized")); }
  });

  io.on("connection", (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    socket.data.subscriptions = new Map();
    socket.data.presence = new Map();
    const expiryTimer = setTimeout(() => socket.disconnect(true), accessTokenRemainingMs(socket.data.accessExpiresAt));
    expiryTimer.unref();
    socket.use((_packet, next) => {
      if (!accessTokenRemainingMs(socket.data.accessExpiresAt)) {
        next(new Error("access_token_expired"));
        socket.disconnect(true);
        return;
      }
      next();
    });
    socket.once("disconnect", () => clearTimeout(expiryTimer));

    socket.on("realtime:subscribe", async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
      const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const channel = typeof input.channel === "string" ? input.channel : "";
      if (!(await canSubscribe(socket, channel))) { ack?.({ ok: false, error: "Channel access denied" }); return; }
      const bindings = Array.isArray(input.bindings) ? input.bindings.filter((item): item is Binding => !!item && typeof item === "object").slice(0, 20) : [];
      socket.data.subscriptions!.set(channel, { channel, bindings });
      await socket.join(channel);
      ack?.({ ok: true });
    });

    socket.on("realtime:unsubscribe", async (raw: unknown, ack?: (result: { ok: boolean }) => void) => {
      const channel = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).channel === "string" ? String((raw as Record<string, unknown>).channel) : "";
      socket.data.subscriptions!.delete(channel);
      socket.data.presence!.delete(channel);
      await socket.leave(channel);
      ack?.({ ok: true });
    });

    const relay = async (raw: unknown, ack?: (result: { ok: boolean; status?: string }) => void) => {
      const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const channel = typeof input.channel === "string" ? input.channel : "";
      if (!socket.data.subscriptions!.has(channel) || !(await canSubscribe(socket, channel))) { ack?.({ ok: false, status: "error" }); return; }
      const event = typeof input.event === "string" ? input.event.slice(0, 100) : "broadcast";
      const message = { channel, topic: channel, type: input.type === "presence" ? "presence" : "broadcast", event, payload: input.payload ?? {} };
      socket.to(channel).emit("realtime:event", message);
      ack?.({ ok: true, status: "ok" });
    };
    socket.on("realtime:send", relay);
    socket.on("broadcast", relay);
    socket.on("realtime:track", async (raw: unknown, ack?: (result: { ok: boolean; status?: string }) => void) => {
      const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const channel = typeof input.channel === "string" ? input.channel : "";
      if (!socket.data.subscriptions!.has(channel)) { ack?.({ ok: false, status: "error" }); return; }
      const presence = input.payload && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {};
      socket.data.presence!.set(channel, presence);
      const message = { channel, topic: channel, type: "presence", event: "sync", payload: { joins: { [socket.data.auth.id]: [presence] }, leaves: {} } };
      socket.to(channel).emit("realtime:event", message);
      ack?.({ ok: true, status: "ok" });
    });
  });

  const listener = (change: DbChangeEvent) => {
    for (const rawSocket of io.sockets.sockets.values()) {
      const socket = rawSocket as AuthedSocket;
      for (const subscription of socket.data.subscriptions?.values() ?? []) {
        if (bindingMatches(subscription, change)) emitEnvelope(socket, subscription.channel, envelopeForChange(subscription, change));
      }
    }
  };
  realtimeEvents.on("db-change", listener);
  io.engine.on("close", () => realtimeEvents.off("db-change", listener));
  logger.info({ path: "/api/socket.io" }, "realtime server attached");
  return io;
}
