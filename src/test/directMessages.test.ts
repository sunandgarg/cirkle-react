import { describe, expect, it } from "vitest";
import {
  getDirectMessageNavigationTarget,
  getDirectMessagePreview,
  normalizeDirectMessageSidebarRow,
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
  it("opens an existing room directly", () => {
    expect(getDirectMessageNavigationTarget(row({ room_id: "room-1" }))).toBe("/chats/room-1");
  });

  it("starts a room only with the accepted peer when none exists", () => {
    expect(getDirectMessageNavigationTarget(row({ peer_id: "peer/with space" }))).toBe("/chats?peer=peer%2Fwith%20space");
  });

  it("normalizes labels and unread counts", () => {
    expect(normalizeDirectMessageSidebarRow(row({ unread_count: -3 }))).toMatchObject({ display_name: "Rahul", unread_count: 0 });
  });

  it("uses concise previews for media", () => {
    expect(getDirectMessagePreview(row({ last_message: { message_type: "image", content: "" } }))).toBe("📷 Photo");
    expect(getDirectMessagePreview(row({ last_message: { message_type: "voice", content: "" } }))).toBe("🎙 Voice message");
  });
});
