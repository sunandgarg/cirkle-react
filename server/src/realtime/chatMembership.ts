import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { DbChangeEvent } from "./events.js";

type Row = Record<string, unknown>;

const activeStatuses = new Set(["active", "joined"]);
const revocationFields = ["deleted_at", "left_at", "removed_at", "revoked_at"] as const;

export function activeChatMembership(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const value = row as Row;
  if (Object.prototype.hasOwnProperty.call(value, "is_active") && value.is_active !== true) return false;
  if (Object.prototype.hasOwnProperty.call(value, "status") && value.status != null) {
    if (typeof value.status !== "string" || !activeStatuses.has(value.status.trim().toLowerCase())) return false;
  }
  return revocationFields.every((field) => value[field] == null);
}

type ChatMembershipClient = Pick<Prisma.TransactionClient, "legacyRecord">;
type LockedChatMembershipClient = Pick<Prisma.TransactionClient, "legacyRecord" | "$queryRaw">;

export type ChatMembershipRecord = {
  id: string;
  record_id: string;
  owner_id: string | null;
  community_id?: string | null;
  data: Prisma.JsonValue;
};

function candidateWhere(userId: string, roomId: string): Prisma.LegacyRecordWhereInput {
  return {
    table_name: "chat_members",
    OR: [
      { record_id: `${roomId}:${userId}` },
      { AND: [
        { data: { path: "$.room_id", equals: roomId } },
        { OR: [
          { owner_id: userId },
          { data: { path: "$.user_id", equals: userId } },
        ] },
      ] },
    ],
  };
}

export function boundChatMembership(record: Pick<ChatMembershipRecord, "owner_id" | "data">, userId: string, roomId: string): boolean {
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) return false;
  const row = record.data as Row;
  return record.owner_id === userId && row.user_id === userId && row.room_id === roomId;
}

export function exactlyOneActiveChatMembership(
  records: Array<Pick<ChatMembershipRecord, "owner_id" | "data">>,
  userId: string,
  roomId: string,
): boolean {
  return records.length === 1
    && boundChatMembership(records[0]!, userId, roomId)
    && activeChatMembership(records[0]!.data);
}

export async function chatMembershipCandidates(
  client: ChatMembershipClient,
  userId: string,
  roomId: unknown,
): Promise<ChatMembershipRecord[]> {
  if (!userId || typeof roomId !== "string" || !roomId) return [];
  return client.legacyRecord.findMany({
    where: candidateWhere(userId, roomId),
    select: { id: true, record_id: true, owner_id: true, community_id: true, data: true },
    orderBy: { id: "asc" },
  });
}

/**
 * Uses the same fail-closed active-membership definition for HTTP, AppSync,
 * Socket.IO, storage, and call authorization. Keeping the database lookup here
 * prevents a soft-revoked row from remaining an authorization credential in a
 * less frequently exercised service path.
 */
export async function hasActiveChatMembership(
  client: ChatMembershipClient,
  userId: string,
  roomId: unknown,
): Promise<boolean> {
  if (typeof roomId !== "string" || !roomId) return false;
  return exactlyOneActiveChatMembership(await chatMembershipCandidates(client, userId, roomId), userId, roomId);
}

/**
 * Performs the authorization read as a locking read inside the caller's
 * transaction. This makes the one membership row an authorization fence until
 * the protected mutation commits, so a concurrent soft removal cannot be
 * overwritten or raced by that mutation.
 */
async function lockedActiveChatMembershipWithMode(
  client: LockedChatMembershipClient,
  userId: string,
  roomId: unknown,
  mode: "share" | "update",
): Promise<ChatMembershipRecord | null> {
  if (!userId || typeof roomId !== "string" || !roomId) return null;
  const lock = mode === "update" ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`;
  const records = await client.$queryRaw<ChatMembershipRecord[]>(Prisma.sql`
    SELECT id, record_id, owner_id, community_id, data
    FROM legacy_records
    WHERE table_name = 'chat_members'
      AND (record_id = ${`${roomId}:${userId}`}
        OR (JSON_UNQUOTE(JSON_EXTRACT(data, '$.room_id')) = ${roomId}
          AND (owner_id = ${userId} OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.user_id')) = ${userId})))
    ORDER BY id
    ${lock}
  `);
  return exactlyOneActiveChatMembership(records, userId, roomId) ? records[0]! : null;
}

export async function lockedActiveChatMembership(
  client: LockedChatMembershipClient,
  userId: string,
  roomId: unknown,
): Promise<ChatMembershipRecord | null> {
  return lockedActiveChatMembershipWithMode(client, userId, roomId, "share");
}

/**
 * Takes an exclusive authorization lock when the protected operation also
 * mutates the membership row itself. This avoids two concurrent cursor writes
 * first sharing the row and then deadlocking while both upgrade their locks.
 */
export async function lockedActiveChatMembershipForUpdate(
  client: LockedChatMembershipClient,
  userId: string,
  roomId: unknown,
): Promise<ChatMembershipRecord | null> {
  return lockedActiveChatMembershipWithMode(client, userId, roomId, "update");
}

export function activeChatMembershipRecordsForUser(
  records: ChatMembershipRecord[],
  userId: string,
): ChatMembershipRecord[] {
  const byRoom = new Map<string, ChatMembershipRecord[]>();
  for (const record of records) {
    const row = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Row : {};
    const rowRoomId = typeof row.room_id === "string" ? row.room_id : "";
    const suffix = `:${userId}`;
    const canonicalRoomId = record.record_id.endsWith(suffix) ? record.record_id.slice(0, -suffix.length) : "";
    if (record.owner_id !== userId && row.user_id !== userId && !canonicalRoomId) continue;
    for (const roomId of new Set([rowRoomId, canonicalRoomId])) {
      if (!roomId) continue;
      const values = byRoom.get(roomId) ?? [];
      values.push(record);
      byRoom.set(roomId, values);
    }
  }
  return [...byRoom.entries()].flatMap(([roomId, candidates]) =>
    exactlyOneActiveChatMembership(candidates, userId, roomId) ? [candidates[0]!] : []);
}

export function activeChatAudienceUserIds(records: ChatMembershipRecord[], roomId: string): string[] {
  const possibleUserIds = new Set<string>();
  const canonicalPrefix = `${roomId}:`;
  for (const record of records) {
    const row = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Row : {};
    const canonicalUserId = record.record_id.startsWith(canonicalPrefix) ? record.record_id.slice(canonicalPrefix.length) : "";
    if (canonicalUserId) possibleUserIds.add(canonicalUserId);
    if (row.room_id === roomId) {
      if (typeof record.owner_id === "string" && record.owner_id) possibleUserIds.add(record.owner_id);
      if (typeof row.user_id === "string" && row.user_id) possibleUserIds.add(row.user_id);
    }
  }
  return [...possibleUserIds].filter((userId) => {
    const candidates = records.filter((record) => {
      const row = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Row : {};
      return record.record_id === `${roomId}:${userId}`
        || (row.room_id === roomId && (record.owner_id === userId || row.user_id === userId));
    });
    return exactlyOneActiveChatMembership(candidates, userId, roomId);
  });
}

const archivedMembershipTable = "_archived_chat_members";

/**
 * Explicit reactivation policy for sanctioned direct/consultation workflows:
 * normalize the pair to one active, structurally bound row and privately
 * archive every duplicate or malformed candidate in the same transaction.
 * The caller must first lock the containing chat room (or its canonical parent)
 * so concurrent reopen attempts serialize.
 */
export async function normalizeActiveChatMembership(
  client: LockedChatMembershipClient,
  input: { userId: string; roomId: string; communityId?: string; lastReadAt?: string | null; now?: Date },
): Promise<ChatMembershipRecord> {
  const { userId, roomId } = input;
  const now = (input.now ?? new Date()).toISOString();
  const candidates = await client.$queryRaw<ChatMembershipRecord[]>(Prisma.sql`
    SELECT id, record_id, owner_id, community_id, data
    FROM legacy_records
    WHERE table_name = 'chat_members'
      AND (record_id = ${`${roomId}:${userId}`}
        OR (JSON_UNQUOTE(JSON_EXTRACT(data, '$.room_id')) = ${roomId}
          AND (owner_id = ${userId} OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.user_id')) = ${userId})))
    ORDER BY (record_id = ${`${roomId}:${userId}`}) DESC, id
    FOR UPDATE
  `);
  const keeper = candidates[0];
  for (const duplicate of candidates.slice(1)) {
    const duplicateRow = duplicate.data && typeof duplicate.data === "object" && !Array.isArray(duplicate.data)
      ? duplicate.data as Row : {};
    await client.legacyRecord.update({
      where: { id: duplicate.id },
      data: {
        table_name: archivedMembershipTable,
        record_id: duplicate.id,
        data: { ...duplicateRow, archived_at: now, archive_reason: "duplicate_chat_membership" } as Prisma.InputJsonValue,
      },
    });
  }
  const current = keeper?.data && typeof keeper.data === "object" && !Array.isArray(keeper.data) ? keeper.data as Row : {};
  const cleaned = Object.fromEntries(Object.entries(current).filter(([key]) => !revocationFields.includes(key as typeof revocationFields[number])
    && key !== "status" && key !== "is_active"));
  const data = {
    ...cleaned,
    id: typeof current.id === "string" && current.id ? current.id : randomUUID(),
    room_id: roomId,
    user_id: userId,
    joined_at: typeof current.joined_at === "string" && current.joined_at ? current.joined_at : now,
    last_read_at: input.lastReadAt !== undefined ? input.lastReadAt : current.last_read_at ?? null,
    status: "active",
    is_active: true,
    updated_at: now,
  } as Prisma.InputJsonValue;
  if (keeper) {
    return client.legacyRecord.update({
      where: { id: keeper.id },
      data: {
        owner_id: userId,
        community_id: input.communityId ?? keeper.community_id,
        data,
      },
      select: { id: true, record_id: true, owner_id: true, community_id: true, data: true },
    });
  }
  return client.legacyRecord.create({
    data: {
      table_name: "chat_members",
      record_id: `${roomId}:${userId}`,
      owner_id: userId,
      community_id: input.communityId,
      data,
    },
    select: { id: true, record_id: true, owner_id: true, community_id: true, data: true },
  });
}

export function revokedChatMembership(change: DbChangeEvent): { userId: string; roomId: string } | null {
  if (change.table !== "chat_members") return null;
  if (change.event !== "DELETE" && activeChatMembership(change.row)) return null;
  const userId = typeof change.row.user_id === "string" ? change.row.user_id : "";
  const roomId = typeof change.row.room_id === "string" ? change.row.room_id : "";
  return userId && roomId ? { userId, roomId } : null;
}
