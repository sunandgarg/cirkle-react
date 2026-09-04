import { getCallInvitePath, parseCallInviteNotification } from "@/lib/callInvites";

export type CirkleNotification = {
  id: string;
  user_id: string;
  title?: string | null;
  message?: string | null;
  type?: string | null;
  link?: string | null;
  is_read?: boolean | null;
  created_at: string;
  [key: string]: unknown;
};

const allowedRoots = new Set([
  "blogs", "calendar", "chats", "cirkle-forum", "consult", "jobs",
  "network", "notifications", "profile", "settings", "u",
]);

export const safeInternalNotificationPath = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const origin = typeof window === "undefined" ? "https://cirkle.world" : window.location.origin;
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) return null;
    const root = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (!allowedRoots.has(root)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
};

export const getNotificationNavigationTarget = (notification: CirkleNotification): string | null => {
  const callInvite = parseCallInviteNotification(notification);
  if (callInvite) return getCallInvitePath(callInvite);
  if (notification.type === "call_invite") return null;

  if (notification.type === "connection_request") return "/network?tab=pending";
  if (notification.type === "connection_response") return "/network?tab=connected";
  // The current Node service emits the shared `connection` type. Preserve the
  // correct destination until old rows and the producer are migrated.
  if (notification.type === "connection") {
    return notification.title?.toLocaleLowerCase().includes("accepted")
      ? "/network?tab=connected"
      : "/network?tab=pending";
  }

  return safeInternalNotificationPath(notification.link);
};

export const getNotificationActionLabel = (notification: CirkleNotification): string | null => {
  if (parseCallInviteNotification(notification)) return "Join call";
  if (notification.type === "call_invite") return null;
  if (notification.type === "connection_request") return "Review request";
  if (notification.type === "connection_response") return "View network";
  if (notification.type === "connection") {
    return notification.title?.toLocaleLowerCase().includes("accepted") ? "View network" : "Review request";
  }
  return getNotificationNavigationTarget(notification) ? "Open" : null;
};
