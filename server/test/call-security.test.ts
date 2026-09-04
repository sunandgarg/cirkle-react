import { describe, expect, it } from "vitest";
import { callSessionRecordIdentity } from "../src/services/data.js";
import {
  DailyRoomProvisionError,
  activeDailyRoomNamesForUser,
  closeDailySessionsForRooms,
  dailyMeetingTokenPayload,
  dailyParticipantLeaseIsFresh,
  dailyRoomCreatePayload,
  dailyRoomNameForSession,
  dailySessionCanBeReused,
  provisionPrivateDailyRoom,
  revokeDailyUserRooms,
  type DailyFetch,
} from "../src/services/daily.js";

const response = (body: Record<string, unknown>, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Daily call room privacy", () => {
  it("creates new rooms as private", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [response({}, 404), response({ name: "room", privacy: "private", url: "https://example.daily.co/room" })];
    const fetcher: DailyFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return responses.shift()!;
    };

    const room = await provisionPrivateDailyRoom({
      roomName: "room",
      mode: "audio",
      headers: { Authorization: "Bearer test" },
      fetcher,
      now: 1_000,
    });

    expect(room.privacy).toBe("private");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://api.daily.co/v1/rooms");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      name: "room",
      privacy: "private",
      properties: { start_video_off: true },
    });
  });

  it("repairs an existing public room before returning it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      response({ name: "room", privacy: "public" }),
      response({ name: "room", privacy: "private", url: "https://example.daily.co/room" }),
    ];
    const fetcher: DailyFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return responses.shift()!;
    };

    const room = await provisionPrivateDailyRoom({ roomName: "room", mode: "video", headers: {}, fetcher });

    expect(room.privacy).toBe("private");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://api.daily.co/v1/rooms/room");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ privacy: "private" });
  });

  it("rejects a room when Daily never confirms private privacy", async () => {
    const responses = [
      response({ name: "room", privacy: "public" }),
      response({ name: "room", privacy: "public" }),
      response({ name: "room", privacy: "public" }),
    ];
    const fetcher: DailyFetch = async () => responses.shift()!;

    await expect(provisionPrivateDailyRoom({ roomName: "room", mode: "video", headers: {}, fetcher }))
      .rejects.toMatchObject<Partial<DailyRoomProvisionError>>({ providerStatus: "privacy_not_private" });
  });

  it("uses the indexed composite identity for call sessions", () => {
    expect(callSessionRecordIdentity("session-id")).toEqual({
      table_name_record_id: { table_name: "call_sessions", record_id: "session-id" },
    });
  });

  it("keeps the creation payload private for both call modes", () => {
    expect(dailyRoomCreatePayload("audio-room", "audio", 1_000)).toMatchObject({
      privacy: "private", properties: { eject_at_room_exp: true },
    });
    expect(dailyRoomCreatePayload("video-room", "video", 1_000)).toMatchObject({
      privacy: "private", properties: { eject_at_room_exp: true },
    });
  });

  it("ejects joined participants when their one-hour token expires", () => {
    expect(dailyMeetingTokenPayload("room", "audio", { id: "member", name: "Member" }, 1_000)).toEqual({
      properties: {
        room_name: "room",
        user_name: "Member",
        user_id: "member",
        exp: 3_601,
        eject_at_token_exp: true,
        start_video_off: true,
      },
    });
  });

  it("uses a unique provider room for each immutable call session", () => {
    const first = dailyRoomNameForSession("11111111-1111-4111-8111-111111111111");
    const second = dailyRoomNameForSession("22222222-2222-4222-8222-222222222222");
    expect(first).toBe("cirkle-11111111111141118111111111111111");
    expect(second).not.toBe(first);
  });

  it("never reuses an expired provider room even when a stale participant looks active", () => {
    const now = new Date("2026-09-04T12:00:00.000Z").getTime();
    expect(dailySessionCanBeReused({ started_at: "2026-09-04T11:30:00.000Z", ended_at: null }, true, now)).toBe(true);
    expect(dailySessionCanBeReused({ started_at: "2026-09-03T11:59:59.999Z", ended_at: null }, true, now)).toBe(false);
  });

  it("expires participant leases unless the connected client refreshes them", () => {
    const now = new Date("2026-09-04T12:00:00.000Z").getTime();
    expect(dailyParticipantLeaseIsFresh({ left_at: null, lease_refreshed_at: "2026-09-04T11:59:00.001Z" }, now)).toBe(true);
    expect(dailyParticipantLeaseIsFresh({ left_at: null, lease_refreshed_at: "2026-09-04T11:58:00.000Z" }, now)).toBe(false);
    expect(dailyParticipantLeaseIsFresh({ left_at: "2026-09-04T11:59:30.000Z", lease_refreshed_at: "2026-09-04T11:59:59.000Z" }, now)).toBe(false);
  });

  it("ejects a joined member and deletes the unique room to revoke unjoined tokens", async () => {
    const calls: Array<{ url: string; method: string | undefined; body?: unknown }> = [];
    const responses = [response({}, 404), response({ deleted: true })];
    const result = await revokeDailyUserRooms(["cirkle-11111111111141118111111111111111"], "member", "test-key", async (input, init) => {
      calls.push({
        url: String(input), method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return responses.shift()!;
    });
    expect(result).toEqual({ revoked: 1, failed: 0 });
    expect(calls).toEqual([
      {
        url: "https://api.daily.co/v1/rooms/cirkle-11111111111141118111111111111111/eject",
        method: "POST", body: { user_ids: ["member"], ban: true },
      },
      {
        url: "https://api.daily.co/v1/rooms/cirkle-11111111111141118111111111111111",
        method: "DELETE",
      },
    ]);
  });

  it("reports room deletion failure even when participant ejection succeeded", async () => {
    const responses = [response({ ejectedIds: ["member"] }), response({}, 503)];
    await expect(revokeDailyUserRooms(["cirkle-11111111111141118111111111111111"], "member", "test-key", async () => responses.shift()!))
      .resolves.toEqual({ revoked: 0, failed: 1 });
  });

  it("still attempts token-revoking room deletion when session ejection has a network failure", async () => {
    const methods: Array<string | undefined> = [];
    await expect(revokeDailyUserRooms(["cirkle-11111111111141118111111111111111"], "member", "test-key", async (_input, init) => {
      methods.push(init?.method);
      if (init?.method === "POST") throw new Error("temporary eject outage");
      return response({ deleted: true });
    })).resolves.toEqual({ revoked: 0, failed: 1 });
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it("ends database call state before provider room revocation", async () => {
    const roomName = "cirkle-11111111111141118111111111111111";
    const session = { id: "session-row", data: { id: "session-1", room_id: "chat-1", daily_room_name: roomName, started_at: "2026-09-04T11:55:00.000Z", ended_at: null } };
    const participant = { id: "participant-row", data: { id: "participant-1", session_id: "session-1", room_id: "chat-1", user_id: "member", joined_at: "2026-09-04T11:56:00.000Z", left_at: null } };
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const client = {
      $queryRaw: async () => [{ id: "session-row" }],
      legacyRecord: {
        findMany: async ({ where }: any) => {
          if (where.table_name === "call_sessions") return [{ id: session.id }];
          if (where.id?.in) return [session];
          if (where.table_name === "call_participants") return [participant];
          return [];
        },
        update: async ({ where, data }: any) => {
          updates.push({ id: where.id, data: data.data });
          return { id: where.id, data: data.data };
        },
      },
    };
    const closed = await closeDailySessionsForRooms(client as any, [roomName], "verification_revoked", new Date("2026-09-04T12:00:00.000Z"));
    expect(closed.roomNames).toEqual([roomName]);
    expect(closed.sessions[0]).toMatchObject({ id: "session-1", ended_at: "2026-09-04T12:00:00.000Z", failure_reason: "verification_revoked" });
    expect(closed.participants[0]).toMatchObject({ id: "participant-1", left_at: "2026-09-04T12:00:00.000Z" });
    expect(updates.map((entry) => entry.id)).toEqual(["participant-row", "session-row"]);
  });

  it("finds only active per-session Daily rooms for a member", async () => {
    const findMany = async ({ where }: any) => where.table_name === "chat_members"
      ? [{ data: { user_id: "member", room_id: "chat-room" } }]
      : [
          { data: { id: "active", daily_room_name: "cirkle-11111111111141118111111111111111", ended_at: null } },
          { data: { id: "ended", daily_room_name: "cirkle-22222222222242228222222222222222", ended_at: new Date().toISOString() } },
        ];
    await expect(activeDailyRoomNamesForUser({ legacyRecord: { findMany } } as any, "member"))
      .resolves.toEqual(["cirkle-11111111111141118111111111111111"]);
  });
});
