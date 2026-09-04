import { describe, expect, it } from "vitest";
import { callSessionRecordIdentity } from "../src/services/data.js";
import {
  DailyRoomProvisionError,
  dailyRoomCreatePayload,
  provisionPrivateDailyRoom,
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
    expect(dailyRoomCreatePayload("audio-room", "audio", 1_000)).toMatchObject({ privacy: "private" });
    expect(dailyRoomCreatePayload("video-room", "video", 1_000)).toMatchObject({ privacy: "private" });
  });
});
