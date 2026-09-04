import type { Prisma } from "@prisma/client";

type DailyRoom = Record<string, unknown>;
type Row = Record<string, unknown>;

export type DailyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface PrivateDailyRoomOptions {
  roomName: string;
  mode: "audio" | "video";
  headers: Record<string, string>;
  fetcher?: DailyFetch;
  now?: number;
}

const dailyApiUrl = "https://api.daily.co/v1";
export const DAILY_PARTICIPANT_LEASE_MS = 2 * 60_000;

export function dailyRoomNameForSession(sessionId: string): string {
  const compact = sessionId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (compact.length !== 32) throw new Error("A canonical call session ID is required");
  return `cirkle-${compact}`;
}

export function dailySessionCanBeReused(session: Row, hasLiveParticipants: boolean, now = Date.now()): boolean {
  if (session.ended_at) return false;
  const startedAt = new Date(String(session.started_at ?? "")).getTime();
  const ageMs = now - startedAt;
  return Number.isFinite(startedAt) && ageMs >= -60_000 && ageMs < 24 * 60 * 60_000
    && (ageMs < 5 * 60_000 || hasLiveParticipants);
}

export function dailyParticipantLeaseIsFresh(participant: Row, now = Date.now()): boolean {
  if (participant.left_at) return false;
  const refreshedAt = new Date(String(
    participant.lease_refreshed_at ?? participant.updated_at ?? participant.joined_at ?? "",
  )).getTime();
  const ageMs = now - refreshedAt;
  return Number.isFinite(refreshedAt) && ageMs >= -60_000 && ageMs < DAILY_PARTICIPANT_LEASE_MS;
}

export class DailyRoomProvisionError extends Error {
  constructor(
    message: string,
    readonly providerStatus: number | "invalid_response" | "privacy_not_private",
  ) {
    super(message);
    this.name = "DailyRoomProvisionError";
  }
}

export function dailyRoomCreatePayload(roomName: string, mode: "audio" | "video", now = Date.now()): DailyRoom {
  return {
    name: roomName,
    privacy: "private",
    properties: {
      exp: Math.floor(now / 1000) + 86_400,
      eject_at_room_exp: true,
      enable_screenshare: true,
      enable_chat: false,
      start_video_off: mode === "audio",
      start_audio_off: false,
      max_participants: 50,
    },
  };
}

export function dailyMeetingTokenPayload(
  roomName: string,
  mode: "audio" | "video",
  user: { id: string; name: string },
  now = Date.now(),
): DailyRoom {
  return {
    properties: {
      room_name: roomName,
      user_name: user.name,
      user_id: user.id,
      exp: Math.floor(now / 1000) + 3_600,
      eject_at_token_exp: true,
      start_video_off: mode === "audio",
    },
  };
}

type DailyRecordClient = Pick<Prisma.TransactionClient, "legacyRecord">;
type DailyMutationClient = Pick<Prisma.TransactionClient, "legacyRecord" | "$queryRaw">;

export interface ClosedDailySessions {
  roomNames: string[];
  sessions: Row[];
  participants: Row[];
}

export async function activeDailyRoomNamesForUser(client: DailyRecordClient, userId: string): Promise<string[]> {
  const memberships = await client.legacyRecord.findMany({ where: {
    table_name: "chat_members",
    owner_id: userId,
  }, select: { data: true } });
  const roomIds = [...new Set(memberships.flatMap((record) => {
    const row = record.data as Row;
    return row.user_id === userId && typeof row.room_id === "string" ? [row.room_id] : [];
  }))];
  const rooms: string[] = [];
  for (let offset = 0; offset < roomIds.length; offset += 100) {
    const batch = roomIds.slice(offset, offset + 100);
    const sessions = await client.legacyRecord.findMany({ where: {
      table_name: "call_sessions",
      OR: batch.map((roomId) => ({ data: { path: "$.room_id", equals: roomId } })),
    }, select: { data: true } });
    for (const record of sessions) {
      const row = record.data as Row;
      if (!row.ended_at && typeof row.daily_room_name === "string" && /^cirkle-[0-9a-f]{24,32}$/.test(row.daily_room_name)) {
        rooms.push(row.daily_room_name);
      }
    }
  }
  return [...new Set(rooms)];
}

export async function closeDailySessionsForRooms(
  client: DailyMutationClient,
  roomNames: string[],
  reason: string,
  now = new Date(),
): Promise<ClosedDailySessions> {
  const names = [...new Set(roomNames ?? [])].filter((roomName) => /^cirkle-[0-9a-f]{24,32}$/.test(roomName));
  if (!names.length) return { roomNames: [], sessions: [], participants: [] };
  const candidates = await client.legacyRecord.findMany({ where: {
    table_name: "call_sessions",
    OR: names.map((roomName) => ({ data: { path: "$.daily_room_name", equals: roomName } })),
  }, select: { id: true } });
  for (const id of candidates.map((record) => record.id).sort()) {
    await client.$queryRaw`SELECT id FROM legacy_records WHERE id = ${id} AND table_name = 'call_sessions' LIMIT 1 FOR UPDATE`;
  }
  const records = candidates.length
    ? await client.legacyRecord.findMany({ where: { id: { in: candidates.map((record) => record.id) } } })
    : [];
  const sessionIds = records.flatMap((record) => {
    const row = record.data as Row;
    return !row.ended_at && typeof row.id === "string" ? [row.id] : [];
  });
  const participantRecords = sessionIds.length ? await client.legacyRecord.findMany({ where: {
    table_name: "call_participants",
    OR: sessionIds.map((sessionId) => ({ data: { path: "$.session_id", equals: sessionId } })),
  } }) : [];
  const endedAt = now.toISOString();
  const participants: Row[] = [];
  for (const record of participantRecords) {
    const current = record.data as Row;
    if (current.left_at) continue;
    const next = { ...current, left_at: endedAt, updated_at: endedAt };
    await client.legacyRecord.update({ where: { id: record.id }, data: { data: next as Prisma.InputJsonValue } });
    participants.push(next);
  }
  const sessions: Row[] = [];
  for (const record of records) {
    const current = record.data as Row;
    if (current.ended_at || typeof current.id !== "string") continue;
    const startedAt = new Date(String(current.started_at ?? "")).getTime();
    const next = {
      ...current,
      ended_at: endedAt,
      duration_seconds: Number.isFinite(startedAt) ? Math.max(0, Math.floor((now.getTime() - startedAt) / 1000)) : 0,
      participant_count: new Set(participantRecords.flatMap((participant) => {
        const row = participant.data as Row;
        return row.session_id === current.id && typeof row.user_id === "string" ? [row.user_id] : [];
      })).size,
      failure_reason: reason,
      updated_at: endedAt,
    };
    await client.legacyRecord.update({ where: { id: record.id }, data: { data: next as Prisma.InputJsonValue } });
    sessions.push(next);
  }
  return { roomNames: names, sessions, participants };
}

export async function revokeDailyUserRooms(
  roomNames: string[] | undefined,
  userId: string,
  apiKey: string,
  fetcher: DailyFetch = fetch,
): Promise<{ revoked: number; failed: number }> {
  let revoked = 0;
  let failed = 0;
  for (const roomName of [...new Set(roomNames ?? [])]) {
    const roomUrl = `${dailyApiUrl}/rooms/${encodeURIComponent(roomName)}`;
    let ejectSettled = false;
    let tokenRevoked = false;
    let roomMissing = false;
    try {
      const ejectResponse = await fetcher(`${roomUrl}/eject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_ids: [userId], ban: true }),
        signal: AbortSignal.timeout(10_000),
      });
      ejectSettled = ejectResponse.ok || ejectResponse.status === 404;
    } catch {
      // Still attempt the room deletion: token invalidation must not be skipped
      // merely because the session-scoped eject endpoint was unavailable.
    }
    try {
      // Ejection is scoped to an existing meeting session. Deleting the
      // immutable per-session room is what invalidates Daily-signed tokens
      // that were issued but have not joined yet. A missing room is safe only
      // because its database session is ended before this provider call and
      // that unique room name will never be provisioned again.
      const deleteResponse = await fetcher(roomUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      roomMissing = deleteResponse.status === 404;
      tokenRevoked = deleteResponse.ok || roomMissing;
    } catch {
      // Report below after both independent provider operations were tried.
    }
    if (tokenRevoked && (ejectSettled || roomMissing)) revoked += 1;
    else failed += 1;
  }
  return { revoked, failed };
}

export function dailyRoomIsPrivate(room: DailyRoom): boolean {
  return room.privacy === "private";
}

async function readRoom(response: Response): Promise<DailyRoom> {
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Daily returned a non-object room payload");
    }
    return value as DailyRoom;
  } catch (error) {
    if (error instanceof DailyRoomProvisionError) throw error;
    throw new DailyRoomProvisionError("Daily returned an invalid room payload", "invalid_response");
  }
}

async function getRoom(roomUrl: string, headers: Record<string, string>, fetcher: DailyFetch): Promise<Response> {
  return fetcher(roomUrl, { headers, signal: AbortSignal.timeout(10_000) });
}

/**
 * Returns a provider-confirmed private room. Public or malformed rooms never
 * progress to meeting-token issuance in the calling workflow.
 */
export async function provisionPrivateDailyRoom({
  roomName,
  mode,
  headers,
  fetcher = fetch,
  now = Date.now(),
}: PrivateDailyRoomOptions): Promise<DailyRoom> {
  const roomUrl = `${dailyApiUrl}/rooms/${encodeURIComponent(roomName)}`;
  let response = await getRoom(roomUrl, headers, fetcher);

  if (response.status === 404) {
    const createResponse = await fetcher(`${dailyApiUrl}/rooms`, {
      method: "POST",
      headers,
      body: JSON.stringify(dailyRoomCreatePayload(roomName, mode, now)),
      signal: AbortSignal.timeout(10_000),
    });

    if (createResponse.ok) {
      response = createResponse;
    } else {
      // Another caller may have created the deterministic room after our GET.
      // Re-read it, but retain the original provider error if it still does not exist.
      const racedResponse = await getRoom(roomUrl, headers, fetcher);
      if (!racedResponse.ok) {
        throw new DailyRoomProvisionError("Daily room creation failed", createResponse.status);
      }
      response = racedResponse;
    }
  }

  if (!response.ok) {
    throw new DailyRoomProvisionError("Daily room lookup failed", response.status);
  }

  let room = await readRoom(response);
  if (!dailyRoomIsPrivate(room)) {
    const repairResponse = await fetcher(roomUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ privacy: "private" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!repairResponse.ok) {
      throw new DailyRoomProvisionError("Daily room privacy repair failed", repairResponse.status);
    }

    room = await readRoom(repairResponse);
    if (!dailyRoomIsPrivate(room)) {
      const verifyResponse = await getRoom(roomUrl, headers, fetcher);
      if (!verifyResponse.ok) {
        throw new DailyRoomProvisionError("Daily room privacy verification failed", verifyResponse.status);
      }
      room = await readRoom(verifyResponse);
    }
  }

  if (!dailyRoomIsPrivate(room)) {
    throw new DailyRoomProvisionError("Daily did not confirm a private room", "privacy_not_private");
  }
  return room;
}
