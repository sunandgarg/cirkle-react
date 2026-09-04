import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import {
  chatAppSyncChannels,
  forumAppSyncChannels,
  inboxAppSyncChannel,
  isValidAppSyncChannel,
  threadAppSyncChannel,
} from "./appsyncChannels.js";
import { realtimeEvents, type DbChangeEvent } from "./events.js";
import { materializeForumReactionChange } from "./forumReactions.js";

const OUTBOX_TABLE = "appsync_realtime_outbox";
const DEAD_LETTER_TABLE = "appsync_realtime_dead_letter";
const MAX_EVENT_BYTES = 200_000;
const MAX_BATCH = 100;
const MAX_ATTEMPTS = 12;

interface OutboxPayload {
  channel: string;
  event: Record<string, unknown>;
  attempts: number;
  next_attempt_at: string;
  last_error?: string;
  failed_at?: string;
}

let drainInFlight: Promise<{ delivered: number; failed: number }> | null = null;
let drainRequested = false;

export const appSyncConfigured = (): boolean => Boolean(
  config.APPSYNC_ENABLED
  && config.APPSYNC_HTTP_ENDPOINT
  && config.APPSYNC_PUBLISH_TOKEN,
);

export function appSyncChannelsForChange(change: DbChangeEvent): string[] {
  const channels = new Set<string>();
  const row = change.row;
  const roomId = typeof row.room_id === "string" ? row.room_id
    : typeof row.chat_room_id === "string" ? row.chat_room_id
      : undefined;

  if (change.table === "posts" && typeof row.scope_type === "string" && typeof row.scope_key === "string") {
    channels.add(forumAppSyncChannels(row.scope_type, row.scope_key).message_channel);
    if (typeof row.reply_to_id === "string" && row.reply_to_id) channels.add(threadAppSyncChannel(row.reply_to_id));
  }
  if (roomId && new Set(["messages", "chat_members", "call_sessions", "call_participants"]).has(change.table)) {
    channels.add(chatAppSyncChannels(roomId).message_channel);
  }
  for (const userId of change.audience_ids ?? []) channels.add(inboxAppSyncChannel(userId));
  for (const key of ["user_id", "requester_id", "receiver_id"] as const) {
    if (typeof row[key] === "string" && row[key]) channels.add(inboxAppSyncChannel(row[key] as string));
  }
  return [...channels].filter(isValidAppSyncChannel);
}

export function appSyncEnvelope(change: DbChangeEvent): Record<string, unknown> {
  const deleted = change.event === "DELETE";
  // AppSync subscriptions cannot be forcibly revoked after AWS has accepted a
  // connection. Durable events are therefore invalidations only: authorized
  // clients refetch the row through the Node API, which rechecks current
  // account, verification, scope and room membership. Never place content,
  // identity, media paths or provider tokens in an AppSync durable envelope.
  const identity = typeof change.row.id === "string" && change.row.id
    ? { id: change.row.id }
    : {};
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    table: change.table,
    eventType: change.event,
    new: deleted ? {} : identity,
    old: deleted ? identity : {},
    occurredAt: new Date().toISOString(),
  };
}

function safePublishedEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.schemaVersion !== 1 || typeof event.table !== "string" || typeof event.eventType !== "string") return event;
  const deleted = event.eventType === "DELETE";
  const source = deleted ? event.old : event.new;
  const identity = source && typeof source === "object" && !Array.isArray(source)
    && typeof (source as Record<string, unknown>).id === "string"
    ? { id: (source as Record<string, unknown>).id }
    : {};
  return { ...event, new: deleted ? {} : identity, old: deleted ? identity : {} };
}

async function publish(channel: string, event: Record<string, unknown>): Promise<void> {
  if (!appSyncConfigured()) throw new Error("AppSync is not configured");
  if (!isValidAppSyncChannel(channel)) throw new Error("Invalid AppSync channel");
  // Also sanitize records already persisted by an older release before they
  // reach AWS during a rolling upgrade.
  const encodedEvent = JSON.stringify(safePublishedEvent(event));
  if (Buffer.byteLength(encodedEvent) > MAX_EVENT_BYTES) throw new Error("AppSync event exceeds the safe size limit");
  const response = await fetch(config.APPSYNC_HTTP_ENDPOINT!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.APPSYNC_PUBLISH_TOKEN!,
    },
    body: JSON.stringify({ channel, events: [encodedEvent] }),
    signal: AbortSignal.timeout(config.APPSYNC_PUBLISH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const providerRequestId = response.headers.get("x-amzn-requestid") || undefined;
    throw new Error(`AppSync publish failed with ${response.status}${providerRequestId ? ` (${providerRequestId})` : ""}`);
  }
  // A handler-enabled Event API can return a successful HTTP response with
  // individual failed entries. This stack has no handler today, but checking
  // the documented response shape prevents silently dropping events if one is
  // added later.
  const body = await response.text();
  if (body) {
    try {
      const result = JSON.parse(body) as { failed?: unknown[] };
      if (Array.isArray(result.failed) && result.failed.length) throw new Error("AppSync rejected one or more published events");
    } catch (error) {
      if (error instanceof Error && error.message === "AppSync rejected one or more published events") throw error;
      // AWS may return an empty or non-JSON acknowledgement; the HTTP status is
      // authoritative unless a structured failure list is present.
    }
  }
}

async function enqueue(change: DbChangeEvent): Promise<void> {
  const routedChange = await materializeForumReactionChange(change);
  const channels = appSyncChannelsForChange(routedChange);
  if (!channels.length) return;
  const event = appSyncEnvelope(routedChange);
  const now = new Date().toISOString();
  await prisma.$transaction(channels.map((channel) => {
    const id = randomUUID();
    const data: OutboxPayload = { channel, event, attempts: 0, next_attempt_at: now };
    return prisma.legacyRecord.create({
      data: {
        table_name: OUTBOX_TABLE,
        record_id: id,
        owner_id: null,
        community_id: null,
        data: data as unknown as Prisma.InputJsonValue,
      },
    });
  }));
}

const errorSummary = (error: unknown): string => (error instanceof Error ? error.message : "AppSync publish failed").slice(0, 240);

const validOutboxPayload = (value: unknown): value is OutboxPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<OutboxPayload>;
  return typeof item.channel === "string" && isValidAppSyncChannel(item.channel)
    && Boolean(item.event) && typeof item.event === "object" && !Array.isArray(item.event)
    && Number.isInteger(item.attempts) && Number(item.attempts) >= 0
    && typeof item.next_attempt_at === "string" && !Number.isNaN(Date.parse(item.next_attempt_at));
};

async function deadLetter(record: { id: string; data: Prisma.JsonValue }, reason: string, now = new Date()): Promise<void> {
  const item = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as unknown as Record<string, unknown> : {};
  await prisma.legacyRecord.update({
    where: { id: record.id },
    data: {
      table_name: DEAD_LETTER_TABLE,
      data: {
        ...item,
        last_error: reason.slice(0, 240),
        failed_at: now.toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
}

async function drainOnce(): Promise<{ delivered: number; failed: number; scanned: number }> {
  if (!appSyncConfigured()) return { delivered: 0, failed: 0, scanned: 0 };
  const dueAt = new Date().toISOString();
  const records = await prisma.legacyRecord.findMany({
    where: {
      table_name: OUTBOX_TABLE,
      data: { path: "$.next_attempt_at", lte: dueAt },
    },
    orderBy: { created_at: "asc" },
    take: MAX_BATCH,
  });
  let delivered = 0;
  let failed = 0;
  const now = Date.now();
  for (const record of records) {
    if (!validOutboxPayload(record.data)) {
      failed += 1;
      await deadLetter(record, "Invalid AppSync outbox payload");
      logger.error({ outbox_id: record.record_id }, "Invalid AppSync outbox record moved to dead letter");
      continue;
    }
    const item = record.data as unknown as OutboxPayload;
    if (item.failed_at) {
      await deadLetter(record, item.last_error || "AppSync retry budget exhausted");
      continue;
    }
    if (Date.parse(item.next_attempt_at) > now) continue;
    try {
      await publish(item.channel, item.event);
      await prisma.legacyRecord.delete({ where: { id: record.id } });
      delivered += 1;
    } catch (error) {
      failed += 1;
      const attempts = Number(item.attempts || 0) + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts, 8));
      await prisma.legacyRecord.update({
        where: { id: record.id },
        data: {
          ...(terminal ? { table_name: DEAD_LETTER_TABLE } : {}),
          data: {
            ...item,
            attempts,
            last_error: errorSummary(error),
            next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
            ...(terminal ? { failed_at: new Date().toISOString() } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      logger.warn({ err: error, outbox_id: record.record_id, attempts, terminal }, "AppSync delivery deferred");
    }
  }
  return { delivered, failed, scanned: records.length };
}

export function dispatchAppSyncOutbox(): Promise<{ delivered: number; failed: number }> {
  drainRequested = true;
  if (drainInFlight) return drainInFlight;
  drainInFlight = (async () => {
    let delivered = 0;
    let failed = 0;
    // Drain bounded batches so a normal traffic burst does not sit behind the
    // retry timer, while still yielding capacity under a sustained flood.
    for (let batch = 0; batch < 10; batch += 1) {
      drainRequested = false;
      const result = await drainOnce();
      delivered += result.delivered;
      failed += result.failed;
      if (result.scanned < MAX_BATCH && !drainRequested) break;
    }
    return { delivered, failed };
  })().finally(() => {
    drainInFlight = null;
    // Close the narrow race where a record is enqueued after the last SELECT
    // but before this promise is released.
    if (drainRequested) queueMicrotask(() => {
      void dispatchAppSyncOutbox().catch((error: unknown) => logger.error({ err: error }, "AppSync follow-up drain failed"));
    });
  });
  return drainInFlight;
}

export function attachAppSyncPublisher(): () => Promise<void> {
  if (!appSyncConfigured()) return async () => undefined;
  const pendingEnqueues = new Set<Promise<unknown>>();
  const listener = (change: DbChangeEvent) => {
    const task = enqueue(change)
      .then(() => dispatchAppSyncOutbox())
      .catch((error: unknown) => logger.error({ err: error, table: change.table, event: change.event }, "AppSync event enqueue failed"))
      .finally(() => pendingEnqueues.delete(task));
    pendingEnqueues.add(task);
  };
  realtimeEvents.on("db-change", listener);
  const timer = setInterval(() => {
    void dispatchAppSyncOutbox().catch((error: unknown) => logger.error({ err: error }, "AppSync outbox retry failed"));
  }, 15_000);
  timer.unref();
  void dispatchAppSyncOutbox().catch((error: unknown) => logger.error({ err: error }, "Initial AppSync outbox drain failed"));
  return async () => {
    clearInterval(timer);
    realtimeEvents.off("db-change", listener);
    // Normal PM2 restarts wait until every already-observed business change is
    // durable in the MySQL outbox before Prisma disconnects. A hard process or
    // host crash between the business commit and EventEmitter delivery remains
    // recoverable through client cursor reconciliation, not an at-least-once
    // transport guarantee.
    await Promise.allSettled([...pendingEnqueues]);
  };
}
