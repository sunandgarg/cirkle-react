export type CallMode = "audio" | "video";

export type CallInvite = {
  roomId: string;
  sessionId: string;
  mode: CallMode;
  expiresAt: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseExpiry = (value: unknown): number | null => {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const isCallId = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

export const parseCallInviteNotification = (value: unknown, now = Date.now()): CallInvite | null => {
  if (!isRecord(value) || value.type !== "call_invite") return null;
  const roomId = value.room_id;
  const sessionId = value.call_session_id;
  const mode = value.call_mode;
  const expiresAt = parseExpiry(value.expires_at);
  if (!isCallId(roomId) || !isCallId(sessionId)) return null;
  if (mode !== "audio" && mode !== "video") return null;
  if (expiresAt === null || expiresAt <= now) return null;
  return { roomId, sessionId, mode, expiresAt };
};

export const getCallInvitePath = (invite: CallInvite): string => {
  const query = new URLSearchParams({
    call: invite.mode,
    session: invite.sessionId,
    expires: String(invite.expiresAt),
  });
  return `/chats/${encodeURIComponent(invite.roomId)}?${query.toString()}`;
};

export const parseCallInviteQuery = (
  roomId: unknown,
  searchParams: Pick<URLSearchParams, "get">,
  now = Date.now(),
): CallInvite | null => {
  const sessionId = searchParams.get("session");
  const mode = searchParams.get("call");
  const rawExpiry = searchParams.get("expires");
  if (!isCallId(roomId) || !isCallId(sessionId)) return null;
  if (mode !== "audio" && mode !== "video") return null;
  if (!rawExpiry || !/^\d{10,16}$/.test(rawExpiry)) return null;
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  return { roomId, sessionId, mode, expiresAt };
};
