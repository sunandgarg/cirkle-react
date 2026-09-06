import { describe, expect, it, vi } from "vitest";
import {
  accessTokenRemainingMs,
  bindingMatches,
  canUsePersonalChannel,
  channelRequiresVerifiedMembership,
  CLIENT_EVENT_LIMIT,
  clientPresenceState,
  clientTypingEnvelope,
  envelopeForChange,
  revokeChatMembershipSubscriptions,
  takeClientEventRateSlot,
  topicMatches,
  type Subscription,
} from "../src/realtime/socket.js";
import {
  activeChatAudienceUserIds,
  activeChatMembership,
  activeChatMembershipRecordsForUser,
  boundChatMembership,
  exactlyOneActiveChatMembership,
  revokedChatMembership,
  type ChatMembershipRecord,
} from "../src/realtime/chatMembership.js";

const postgres = (channel: string, table: string): Subscription => ({
  channel,
  bindings: [{ type: "postgres_changes", filter: { table, event: "*" } }],
});

describe("realtime topic isolation", () => {
  it("expires established sockets when their access token expires", () => {
    expect(accessTokenRemainingMs(10_000, 9_250)).toBe(750);
    expect(accessTokenRemainingMs(10_000, 10_001)).toBe(0);
  });
  it("requires live verification for personal channels that carry protected activity", () => {
    expect(channelRequiresVerifiedMembership("notifications-realtime-11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(channelRequiresVerifiedMembership("direct-message-sidebar-11111111-1111-4111-8111-111111111111-subscription")).toBe(true);
    expect(channelRequiresVerifiedMembership("member-profile:11111111-1111-4111-8111-111111111111")).toBe(false);
  });
  it("never lets a moderator impersonate another member's personal stream", () => {
    expect(canUsePersonalChannel(
      "direct-message-sidebar-11111111-1111-4111-8111-111111111111-subscription",
      "22222222-2222-4222-8222-222222222222",
    )).toBe(false);
    expect(canUsePersonalChannel(
      "notifications-realtime-11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    )).toBe(true);
  });
  it("does not deliver another member's connection change to a broad binding", () => {
    const subscription = postgres("connections-11111111-1111-4111-8111-111111111111", "connections");
    expect(bindingMatches(subscription, {
      table: "connections", event: "INSERT",
      row: { requester_id: "22222222-2222-4222-8222-222222222222", receiver_id: "33333333-3333-4333-8333-333333333333" },
    })).toBe(false);
    expect(bindingMatches(subscription, {
      table: "connections", event: "UPDATE",
      row: { requester_id: "11111111-1111-4111-8111-111111111111", receiver_id: "33333333-3333-4333-8333-333333333333" },
    })).toBe(true);
  });

  it("uses derived room audiences for direct-message sidebar changes", () => {
    const channel = "direct-message-sidebar-11111111-1111-4111-8111-111111111111";
    const change = { table: "messages", event: "INSERT" as const, row: { room_id: "private-room" }, audience_ids: ["11111111-1111-4111-8111-111111111111"] };
    expect(topicMatches(channel, change)).toBe(true);
    expect(topicMatches("direct-message-sidebar-22222222-2222-4222-8222-222222222222", change)).toBe(false);
  });

  it("revokes every fallback subscription and closes the transport synchronously when membership is removed", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const roomId = "private-room";
    const leave = vi.fn(() => Promise.resolve());
    const subscriptions = new Map([
      [`room-${roomId}`, postgres(`room-${roomId}`, "messages")],
      [`chat:${roomId}`, { channel: `chat:${roomId}`, bindings: [] }],
      [`direct-message-sidebar-${userId}-subscription`, { channel: `direct-message-sidebar-${userId}-subscription`, bindings: [] }],
      ["forum:GLOBAL:IIT_ALL", { channel: "forum:GLOBAL:IIT_ALL", bindings: [] }],
    ]);
    const presence = new Map([[`chat:${roomId}`, { online: true }]]);
    const close = vi.fn();
    const socket = { data: { auth: { id: userId }, subscriptions, presence }, leave, conn: { close } };

    expect(revokeChatMembershipSubscriptions([socket], {
      table: "chat_members", event: "DELETE", row: { user_id: userId, room_id: roomId },
    })).toBe(4);
    expect([...subscriptions.keys()]).toEqual([]);
    expect(presence.size).toBe(0);
    expect(leave).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats explicit inactive membership updates as revocations without touching read cursors", () => {
    const active = { user_id: "member", room_id: "room", last_read_at: new Date().toISOString() };
    expect(activeChatMembership(active)).toBe(true);
    expect(revokedChatMembership({ table: "chat_members", event: "UPDATE", row: active })).toBeNull();
    expect(revokedChatMembership({
      table: "chat_members", event: "UPDATE", row: { ...active, status: "removed" },
    })).toEqual({ userId: "member", roomId: "room" });
  });

  it.each([
    [{ user_id: "member", room_id: "room" }, true],
    [{ user_id: "member", room_id: "room", status: "active", is_active: true }, true],
    [{ user_id: "member", room_id: "room", status: "removed" }, false],
    [{ user_id: "member", room_id: "room", status: "future-state" }, false],
    [{ user_id: "member", room_id: "room", is_active: "false" }, false],
    [{ user_id: "member", room_id: "room", removed_at: "" }, false],
  ])("parses active membership markers fail closed for %j", (row, expected) => {
    expect(activeChatMembership(row)).toBe(expected);
  });

  it("requires exactly one structurally bound active row and excludes ambiguous audiences", () => {
    const valid = {
      id: "one", record_id: "source-one", owner_id: "member", community_id: null,
      data: { user_id: "member", room_id: "room", last_read_at: "2026-09-04T00:00:00.000Z" },
    } satisfies ChatMembershipRecord;
    const duplicate = { ...valid, id: "two", record_id: "source-two" } satisfies ChatMembershipRecord;
    const malformed = { ...valid, id: "bad", record_id: "source-bad", owner_id: "someone-else" } satisfies ChatMembershipRecord;
    expect(boundChatMembership(valid, "member", "room")).toBe(true);
    expect(boundChatMembership(malformed, "member", "room")).toBe(false);
    expect(exactlyOneActiveChatMembership([valid], "member", "room")).toBe(true);
    expect(exactlyOneActiveChatMembership([valid, duplicate], "member", "room")).toBe(false);
    expect(activeChatMembershipRecordsForUser([valid, duplicate], "member")).toEqual([]);
    expect(activeChatAudienceUserIds([valid, duplicate], "room")).toEqual([]);
  });

  it("keeps protected messages out of notification-only personal channels", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const change = { table: "messages", event: "INSERT" as const, row: { room_id: "private-room" }, audience_ids: [userId] };
    expect(topicMatches(`notifications-realtime-${userId}`, change)).toBe(false);
    expect(topicMatches(`direct-message-sidebar-${userId}-subscription`, change)).toBe(true);
    expect(topicMatches(`notifications-realtime-${userId}`, {
      table: "notifications", event: "INSERT", row: { user_id: userId }, audience_ids: [userId],
    })).toBe(true);
  });

  it("keeps forum changes inside their exact scope", () => {
    const change = { table: "posts", event: "INSERT" as const, row: { scope_type: "IIT", scope_key: "IIT_DELHI" } };
    expect(bindingMatches(postgres("forum:IIT:IIT_DELHI", "posts"), change)).toBe(true);
    expect(bindingMatches(postgres("forum:IIT:IIT_BOMBAY", "posts"), change)).toBe(false);
  });

  it("routes the unfiltered Forum database fallback only to its authorized exact scope", () => {
    const subscription = postgres("forum-pg-IIT-IIT_DELHI", "posts");
    const matching = { table: "posts", event: "UPDATE" as const, row: { scope_type: "IIT", scope_key: "IIT_DELHI" } };
    const neighboring = { table: "posts", event: "UPDATE" as const, row: { scope_type: "IIT", scope_key: "IIT_BOMBAY" } };

    expect(bindingMatches(subscription, matching)).toBe(true);
    expect(bindingMatches(subscription, neighboring)).toBe(false);
  });

  it("ignores client-shaped room hints from unrelated legacy tables", () => {
    expect(topicMatches("forum:CAMPUS:IIT_DELHI", {
      table: "document_verifications", event: "INSERT",
      room: "forum:CAMPUS:IIT_DELHI",
      row: { scope_type: "CAMPUS", scope_key: "IIT_DELHI", content: "forged" },
    })).toBe(false);
    expect(topicMatches("room-private-room", {
      table: "education", event: "UPDATE", room: "room-private-room", row: { room_id: "private-room" },
    })).toBe(false);
  });

  it("uses the matching database envelope on a mixed typing and message channel", () => {
    const subscription: Subscription = {
      channel: "room-room-id",
      bindings: [
        { type: "broadcast", filter: { event: "typing" } },
        { type: "postgres_changes", filter: { table: "messages", event: "*" } },
      ],
    };
    const envelope = envelopeForChange(subscription, {
      table: "messages", event: "INSERT", row: { room_id: "room-id", id: "message-id" },
    });
    expect(envelope).toMatchObject({ type: "postgres_changes", event: "INSERT", payload: { table: "messages", eventType: "INSERT" } });
  });

  it("never accepts client-authored database change broadcasts", () => {
    const identity = { id: "11111111-1111-4111-8111-111111111111", name: "Verified Member" };
    expect(clientTypingEnvelope(identity, {
      channel: "chat:private-room", type: "broadcast", event: "INSERT",
      payload: { id: "forged-message", sender_id: identity.id },
    })).toBeNull();
    expect(clientTypingEnvelope(identity, {
      channel: "forum:GLOBAL:IIT_ALL", type: "broadcast", event: "typing", payload: {},
    })).toBeNull();
  });

  it("sanitizes typing and presence identity from the authenticated socket", () => {
    const identity = { id: "11111111-1111-4111-8111-111111111111", name: "Verified Member" };
    expect(clientTypingEnvelope(identity, {
      channel: "room-private-room", type: "broadcast", event: "typing",
      payload: { userId: "attacker", name: "Imposter", typing: true, arbitrary: { admin: true } },
    })).toEqual({
      channel: "room-private-room", topic: "room-private-room", type: "broadcast", event: "typing",
      payload: { userId: identity.id, name: identity.name, typing: true },
    });
    expect(clientPresenceState(identity, { userId: "attacker", status: "busy", secret: "discarded" }, new Date("2026-09-04T00:00:00.000Z")))
      .toEqual({ userId: identity.id, name: identity.name, status: "busy", onlineAt: "2026-09-04T00:00:00.000Z" });
    expect(clientPresenceState(identity, { status: "administrator" })).toBeNull();
  });

  it("rate-limits ephemeral client events per channel", () => {
    const windows = new Map();
    for (let index = 0; index < CLIENT_EVENT_LIMIT; index += 1) {
      expect(takeClientEventRateSlot(windows, "room:typing", 1_000)).toBe(true);
    }
    expect(takeClientEventRateSlot(windows, "room:typing", 1_000)).toBe(false);
    expect(takeClientEventRateSlot(windows, "room:typing", 11_000)).toBe(true);
  });
});
