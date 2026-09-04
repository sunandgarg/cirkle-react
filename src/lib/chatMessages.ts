export type ChatTimelineMessage = {
  id: string;
  client_id?: string | null;
  created_at: string;
  room_id: string;
};

export const isChatMessageRealtimeEvent = (event: unknown): boolean => {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  return (event as Record<string, unknown>).table === "messages";
};

export const uniqueChatMessages = <T extends ChatTimelineMessage>(items: T[]): T[] => {
  const byKey = new Map<string, T>();
  for (const message of items) {
    const key = message.client_id || message.id;
    const previous = byKey.get(key);
    if (!previous || previous.id.startsWith("optimistic-")) byKey.set(key, message);
  }
  return [...byKey.values()].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
};

/** Keeps live arrivals while cache and initial server history resolve in parallel. */
export const mergeChatTimeline = <T extends ChatTimelineMessage>(
  current: T[],
  incoming: T[],
  roomId: string,
) => uniqueChatMessages([
  ...current.filter((message) => message.room_id === roomId),
  ...incoming.filter((message) => message.room_id === roomId),
]);
