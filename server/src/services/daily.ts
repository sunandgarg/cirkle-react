type DailyRoom = Record<string, unknown>;

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
      enable_screenshare: true,
      enable_chat: false,
      start_video_off: mode === "audio",
      start_audio_off: false,
      max_participants: 50,
    },
  };
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
