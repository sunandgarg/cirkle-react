import { beforeEach, describe, expect, it } from "vitest";
import {
  getConnectionMessageNavigationTarget,
  getDirectChatBackTarget,
  getDirectChatProfileTarget,
  getDirectMessageNavigationTarget,
  getDirectMessagePreview,
  hasStartedDirectMessageConversation,
  normalizeDirectMessageConnectionResult,
  normalizeDirectMessageSidebarRow,
  readDirectMessageSidebarCache,
  shouldShowConversationNotificationBell,
  writeDirectMessageSidebarCache,
  type DirectMessageSidebarRow,
} from "@/lib/directMessages";

const row = (overrides: Partial<DirectMessageSidebarRow> = {}): DirectMessageSidebarRow => ({
  connection_id: "connection-1",
  peer_id: "peer-1",
  room_id: null,
  display_name: "  Rahul  ",
  display_avatar: null,
  last_message: null,
  unread_count: 0,
  ...overrides,
});

describe("direct message sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("returns a private chat to the open Forum channel panel", () => {
    expect(getDirectChatBackTarget()).toBe("/cirkle-forum?channels=open");
    expect(getDirectChatProfileTarget("peer/with space")).toBe("/profile/peer%2Fwith%20space");
  });

  it("keeps the global notification bell out of one-to-one conversations", () => {
    expect(shouldShowConversationNotificationBell(false)).toBe(false);
    expect(shouldShowConversationNotificationBell(true)).toBe(true);
  });

  it("opens an existing room directly", () => {
    expect(getDirectMessageNavigationTarget(row({ room_id: "room-1" }))).toBe("/chats/room-1");
  });

  it("starts a room only with the accepted peer when none exists", () => {
    expect(getDirectMessageNavigationTarget(row({ peer_id: "peer/with space" }))).toBe("/chats?peer=peer%2Fwith%20space");
  });

  it("opens connection search results without exposing unrelated members", () => {
    expect(getConnectionMessageNavigationTarget({
      peer_id: "peer/with space", room_id: null, display_name: "Rahul",
      display_avatar: null, headline: null,
    })).toBe("/chats?peer=peer%2Fwith%20space");
    expect(getConnectionMessageNavigationTarget({
      peer_id: "peer-1", room_id: "room-1", display_name: "Rahul",
      display_avatar: null, headline: null,
    })).toBe("/chats/room-1");
  });

  it("normalizes labels and unread counts", () => {
    expect(normalizeDirectMessageSidebarRow(row({ unread_count: -3 }))).toMatchObject({ display_name: "Rahul", unread_count: 0 });
  });

  it("normalizes the original MySQL connection-search field aliases", () => {
    expect(normalizeDirectMessageConnectionResult({
      user_id: "peer-legacy", name: "  Priya  ", avatar_url: "/priya.webp", headline: " Product ",
    })).toEqual({
      peer_id: "peer-legacy", room_id: null, display_name: "Priya",
      display_avatar: "/priya.webp", headline: "Product",
    });
    expect(normalizeDirectMessageConnectionResult({ name: "Missing identity" })).toBeNull();
  });

  it("hydrates only started conversations from the viewer-scoped cache", () => {
    const started = row({
      room_id: "room-1",
      last_message: { id: "message-1", content: "Hello", created_at: "2026-09-08T10:00:00.000Z" },
    });
    writeDirectMessageSidebarCache("viewer-1", [started, row({ connection_id: "unstarted" })]);

    expect(readDirectMessageSidebarCache("viewer-1")).toEqual([
      expect.objectContaining({ connection_id: "connection-1", room_id: "room-1" }),
    ]);
    expect(readDirectMessageSidebarCache("viewer-2")).toEqual([]);
  });

  it("uses concise previews for media", () => {
    expect(getDirectMessagePreview(row({ last_message: { message_type: "image", content: "" } }))).toBe("📷 Photo");
    expect(getDirectMessagePreview(row({ last_message: { message_type: "voice", content: "" } }))).toBe("🎙 Voice message");
  });

  it("shows only rooms that already contain a direct message", () => {
    expect(hasStartedDirectMessageConversation(row())).toBe(false);
    expect(hasStartedDirectMessageConversation(row({ room_id: "room-1" }))).toBe(false);
    expect(hasStartedDirectMessageConversation(row({
      room_id: "room-1",
      last_message: { created_at: "2026-09-04T10:00:00.000Z", content: "Hello" },
    }))).toBe(true);
    expect(hasStartedDirectMessageConversation(row({
      room_id: "room-1",
      last_message: { id: "message-1", content: "Legacy hello" },
    }))).toBe(true);
  });
});
