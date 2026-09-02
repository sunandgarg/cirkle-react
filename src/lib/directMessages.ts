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

export const normalizeDirectMessageSidebarRow = (row: DirectMessageSidebarRow): DirectMessageSidebarRow => ({
  ...row,
  display_name: row.display_name?.trim() || "Cirkle member",
  display_avatar: row.display_avatar || null,
  room_id: row.room_id || null,
  last_message: row.last_message && typeof row.last_message === "object" ? row.last_message : null,
  unread_count: Math.max(0, Number(row.unread_count || 0)),
});

export const getDirectMessageNavigationTarget = (row: DirectMessageSidebarRow) =>
  row.room_id ? `/chats/${row.room_id}` : `/chats?peer=${encodeURIComponent(row.peer_id)}`;

export const getDirectMessagePreview = (row: DirectMessageSidebarRow) => {
  if (!row.last_message) return "Start a private conversation";
  if (row.last_message.message_type === "image" || row.last_message.content?.startsWith("📷")) return "📷 Photo";
  if (row.last_message.message_type === "voice") return "🎙 Voice message";
  return row.last_message.content?.trim() || "New message";
};
