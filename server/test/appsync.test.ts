import { describe, expect, it } from "vitest";
import { canSubscribeAppSyncChannel } from "../src/realtime/appsyncAccess.js";
import { forumAppSyncChannels, isCanonicalRealtimeRecordId, isValidAppSyncChannel, threadAppSyncChannel } from "../src/realtime/appsyncChannels.js";
import { appSyncChannelsForChange, appSyncEnvelope } from "../src/realtime/appsyncPublisher.js";
import { AppSyncFixedWindowRateLimiter } from "../src/realtime/appsyncRateLimit.js";
import { materializeForumReactionChange } from "../src/realtime/forumReactions.js";

describe("AppSync Events channel contracts", () => {
  it("converts arbitrary forum scope keys into valid, stable AppSync paths", () => {
    const first = forumAppSyncChannels("COHORT_GLOBAL", "BTECH|Computer Science & Engineering|2026");
    const second = forumAppSyncChannels("COHORT_GLOBAL", "BTECH|Computer Science & Engineering|2026");
    expect(first).toEqual(second);
    expect(first.message_channel).toMatch(/^\/forum\/cohort-global\/[a-f0-9]{32}$/);
    expect(Object.values(first).every(isValidAppSyncChannel)).toBe(true);
  });

  it("uses only canonical non-colliding post IDs for authorized thread channels", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(isCanonicalRealtimeRecordId(id)).toBe(true);
    expect(isCanonicalRealtimeRecordId("secret!")).toBe(false);
    expect(threadAppSyncChannel(id)).toBe(`/thread/${id}`);
    expect(threadAppSyncChannel("secret")).not.toBe(threadAppSyncChannel("secret!"));
  });

  it("routes durable changes only to their authorized audience channels", () => {
    const postChannels = appSyncChannelsForChange({
      table: "posts",
      event: "INSERT",
      row: { id: "11111111-1111-4111-8111-111111111111", scope_type: "GLOBAL", scope_key: "IIT_ALL" },
    });
    expect(postChannels).toHaveLength(1);
    expect(postChannels[0]).toMatch(/^\/forum\/global\//);

    const chatChannels = appSyncChannelsForChange({
      table: "messages",
      event: "INSERT",
      row: { id: "m1", room_id: "22222222-2222-4222-8222-222222222222" },
      audience_ids: ["33333333-3333-4333-8333-333333333333"],
    });
    expect(chatChannels).toEqual([
      "/chat/22222222-2222-4222-8222-222222222222",
      "/inbox/33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("uses content-free invalidation envelopes for durable changes", () => {
    const envelope = appSyncEnvelope({ table: "messages", event: "DELETE", row: {
      id: "m1", content: "private", sender_id: "member-1", media_path: "member-1/private.pdf", file_size: 42n,
    } });
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      table: "messages",
      eventType: "DELETE",
      new: {},
      old: { id: "m1" },
    });
    expect(JSON.stringify(envelope)).not.toContain("private");
    expect(JSON.stringify(envelope)).not.toContain("member-1");
  });

  it("materializes forum reactions as authoritative scoped post updates", async () => {
    const source = {
      post: { findUnique: async () => ({
        id: "post-1", scope_type: "GLOBAL", scope_key: "IIT_ALL", reply_to_id: null,
        deleted_at: null, is_deleted_for_everyone: false,
      }) },
      reaction: { findMany: async () => [{ emoji: "👍" }, { emoji: "👍" }, { emoji: "❤️" }] },
    };
    await expect(materializeForumReactionChange({
      table: "reactions", event: "DELETE",
      row: { entity_id: "post-1", entity_type: "forum_msg", user_id: "member-1", emoji: "👍" },
    }, source)).resolves.toMatchObject({
      table: "posts", event: "UPDATE",
      row: { id: "post-1", scope_type: "GLOBAL", scope_key: "IIT_ALL", reactions: { "👍": 2, "❤️": 1 } },
    });
  });

  it("serializes aggregate snapshots for rapid changes on the same post", async () => {
    let active = 0;
    let maxActive = 0;
    const source = {
      post: { findUnique: async () => ({
        id: "post-ordered", scope_type: "GLOBAL", scope_key: "IIT_ALL", reply_to_id: null,
        deleted_at: null, is_deleted_for_everyone: false,
      }) },
      reaction: { findMany: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [{ emoji: "👍" }];
      } },
    };
    const change = { table: "reactions", event: "INSERT" as const, row: { entity_id: "post-ordered", entity_type: "forum_msg" } };
    await Promise.all([
      materializeForumReactionChange(change, source),
      materializeForumReactionChange(change, source),
      materializeForumReactionChange(change, source),
    ]);
    expect(maxActive).toBe(1);
  });

  it("lets platform moderators subscribe only to well-formed forum channels", async () => {
    const admin = { id: "admin", email: "admin@cirkle.world", role: "admin" as const, community_id: "iit-community", is_verified: true };
    const channels = forumAppSyncChannels("GLOBAL", "IIT_ALL");
    await expect(canSubscribeAppSyncChannel(admin, channels.message_channel)).resolves.toBe(true);
    await expect(canSubscribeAppSyncChannel(admin, "/forum/global/not-a-real-digest")).resolves.toBe(false);
    await expect(canSubscribeAppSyncChannel(admin, "/other/not-a-forum-channel")).resolves.toBe(false);
  });

  it("rate-limits each authenticated publisher key and bounds retained keys", () => {
    const limiter = new AppSyncFixedWindowRateLimiter(10_000, 2, 2);
    expect(limiter.take("member-1/channel-a", 1_000).allowed).toBe(true);
    expect(limiter.take("member-1/channel-a", 1_001).allowed).toBe(true);
    expect(limiter.take("member-1/channel-a", 1_002)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.take("member-1/channel-a", 11_000).allowed).toBe(true);
    expect(limiter.take("member-2/channel-a", 11_000).allowed).toBe(true);
    expect(limiter.take("member-3/channel-a", 11_000).allowed).toBe(true);
  });
});
