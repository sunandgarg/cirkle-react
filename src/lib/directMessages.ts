export type DirectMessageSidebarRow = {
  connection_id: string;
  peer_id: string;
  room_id: string | null;
  display_name: string | null;
  display_avatar: string | null;
  last_message: {
    id?: string;
    content?: string;
    created_at?: string;
    sender_id?: string;
    message_type?: string;
  } | null;
  unread_count: number;
};

export type DirectMessageConnectionResult = {
  peer_id: string;
  room_id: string | null;
  display_name: string | null;
  display_avatar: string | null;
  headline: string | null;
};

type DirectMessageConnectionWireRow = Partial<DirectMessageConnectionResult> & {
  user_id?: unknown;
  name?: unknown;
  avatar_url?: unknown;
};

const directMessageSidebarCacheVersion = 1;
const directMessageSidebarCacheMaxAgeMs = 24 * 60 * 60 * 1000;
const directMessageSidebarCacheKey = (userId: string) => `cirkle:direct-message-sidebar:${userId}`;

export const normalizeDirectMessageSidebarRow = (row: DirectMessageSidebarRow): DirectMessageSidebarRow => ({
  ...row,
  display_name: row.display_name?.trim() || "Cirkle member",
  display_avatar: row.display_avatar || null,
  room_id: row.room_id || null,
  last_message: row.last_message && typeof row.last_message === "object" ? row.last_message : null,
  unread_count: Math.max(0, Number(row.unread_count || 0)),
});

/**
 * Accepts both the canonical RPC contract and the field names returned by the
 * first MySQL compatibility implementation. This keeps mixed frontend/backend
 * rollouts usable instead of rendering every connection as an unknown member.
 */
export const normalizeDirectMessageConnectionResult = (
  candidate: unknown,
): DirectMessageConnectionResult | null => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const row = candidate as DirectMessageConnectionWireRow;
  const peerId = typeof row.peer_id === "string" && row.peer_id
    ? row.peer_id
    : typeof row.user_id === "string" && row.user_id ? row.user_id : "";
  if (!peerId) return null;
  return {
    peer_id: peerId,
    room_id: typeof row.room_id === "string" && row.room_id ? row.room_id : null,
    display_name: typeof row.display_name === "string" && row.display_name.trim()
      ? row.display_name.trim()
      : typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Cirkle member",
    display_avatar: typeof row.display_avatar === "string" && row.display_avatar
      ? row.display_avatar
      : typeof row.avatar_url === "string" && row.avatar_url ? row.avatar_url : null,
    headline: typeof row.headline === "string" && row.headline.trim() ? row.headline.trim() : null,
  };
};

export const readDirectMessageSidebarCache = (userId?: string): DirectMessageSidebarRow[] => {
  if (!userId || typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(directMessageSidebarCacheKey(userId)) || "null") as {
      version?: unknown;
      cached_at?: unknown;
      rows?: unknown;
    } | null;
    if (!parsed || parsed.version !== directMessageSidebarCacheVersion
      || typeof parsed.cached_at !== "number"
      || Date.now() - parsed.cached_at > directMessageSidebarCacheMaxAgeMs
      || !Array.isArray(parsed.rows)) return [];
    return parsed.rows.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const row = candidate as DirectMessageSidebarRow;
      if (typeof row.connection_id !== "string" || !row.connection_id
        || typeof row.peer_id !== "string" || !row.peer_id) return [];
      const normalized = normalizeDirectMessageSidebarRow(row);
      return hasStartedDirectMessageConversation(normalized) ? [normalized] : [];
    });
  } catch {
    return [];
  }
};

export const writeDirectMessageSidebarCache = (userId: string, rows: DirectMessageSidebarRow[]): void => {
  if (!userId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(directMessageSidebarCacheKey(userId), JSON.stringify({
      version: directMessageSidebarCacheVersion,
      cached_at: Date.now(),
      rows,
    }));
  } catch {
    // A full/disabled browser cache must never prevent the authoritative inbox
    // from rendering.
  }
};

export const hasStartedDirectMessageConversation = (row: DirectMessageSidebarRow): boolean =>
  Boolean(row.room_id && row.last_message && (row.last_message.id || row.last_message.created_at));

export const getDirectMessageNavigationTarget = (row: DirectMessageSidebarRow) =>
  row.room_id ? `/chats/${row.room_id}` : `/chats?peer=${encodeURIComponent(row.peer_id)}`;

export const getConnectionMessageNavigationTarget = (row: DirectMessageConnectionResult) =>
  row.room_id ? `/chats/${row.room_id}` : `/chats?peer=${encodeURIComponent(row.peer_id)}`;

export const getDirectChatBackTarget = () => "/cirkle-forum?channels=open";

export const getDirectChatProfileTarget = (peerId: string) => `/profile/${encodeURIComponent(peerId)}`;

export const shouldShowConversationNotificationBell = (isGroup: boolean) => isGroup;

export const getDirectMessagePreview = (row: DirectMessageSidebarRow) => {
  if (!row.last_message) return "Start a private conversation";
  if (row.last_message.message_type === "image" || row.last_message.content?.startsWith("📷")) return "📷 Photo";
  if (row.last_message.message_type === "voice") return "🎙 Voice message";
  return row.last_message.content?.trim() || "New message";
};
