import { describe, expect, it } from "vitest";
import {
  accessTokenRemainingMs,
  bindingMatches,
  canUsePersonalChannel,
  channelRequiresVerifiedMembership,
  CLIENT_EVENT_LIMIT,
  clientPresenceState,
  clientTypingEnvelope,
  envelopeForChange,
  takeClientEventRateSlot,
  topicMatches,
  type Subscription,
} from "../src/realtime/socket.js";

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
