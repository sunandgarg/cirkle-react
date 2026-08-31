import { describe, expect, it } from "vitest";
import { applyForumRealtimeBatch, applyForumRealtimeEvent, getForumBroadcastRow } from "@/lib/forumRealtime";

type VirtualAgent = {
  id: string;
  zone: string;
  room: string;
  inbox: Record<string, any>[];
};

describe("forum burst and isolation simulation", () => {
  it("normalizes current and legacy Supabase Broadcast Change envelopes", () => {
    const current = { payload: { record: { id: "new-row" }, old_record: { id: "old-row" } } };
    const legacy = { payload: { new: { id: "legacy-new" }, old: { id: "legacy-old" } } };

    expect(getForumBroadcastRow(current, "new")?.id).toBe("new-row");
    expect(getForumBroadcastRow(current, "old")?.id).toBe("old-row");
    expect(getForumBroadcastRow(legacy, "new")?.id).toBe("legacy-new");
    expect(getForumBroadcastRow(legacy, "old")?.id).toBe("legacy-old");
  });

  it("routes 1,000 simultaneous hot-room messages across 10,000 virtual agents", () => {
    const zoneCount = 10;
    const agentsPerZone = 1_000;
    const agents: VirtualAgent[] = Array.from({ length: zoneCount * agentsPerZone }, (_, index) => {
      const zone = `ZONE_${Math.floor(index / agentsPerZone)}`;
      return { id: `agent-${index}`, zone, room: `CAMPUS:${zone}`, inbox: [] };
    });
    expect(agents).toHaveLength(10_000);

    const hotRoom = "CAMPUS:ZONE_0";
    const hotAgents = agents.filter((agent) => agent.room === hotRoom);
    const coldAgents = agents.filter((agent) => agent.room !== hotRoom);
    expect(hotAgents).toHaveLength(1_000);

    const burst = Array.from({ length: 1_000 }, (_, sequence) => ({
      eventType: "INSERT" as const,
      new: {
        id: `hot-${sequence}`,
        scope_type: "CAMPUS",
        scope_key: "ZONE_0",
        author_id: hotAgents[sequence].id,
        content: `Concurrent message ${sequence}`,
        created_at: new Date(1_800_000_000_000 + sequence).toISOString(),
      },
    }));

    const startedAt = performance.now();
    for (const agent of hotAgents) {
      agent.inbox = applyForumRealtimeBatch(
        agent.inbox,
        burst,
        { type: "CAMPUS", key: "ZONE_0" },
        1_200,
      );
    }
    const elapsedMs = performance.now() - startedAt;

    for (const agent of hotAgents) {
      expect(agent.inbox).toHaveLength(1_000);
      expect(agent.inbox[0].id).toBe("hot-0");
      expect(agent.inbox[999].id).toBe("hot-999");
      expect(new Set(agent.inbox.map((message) => message.id)).size).toBe(1_000);
    }
    expect(coldAgents.every((agent) => agent.inbox.length === 0)).toBe(true);

    // This is an in-process correctness/load simulation, not a claim about
    // internet or database capacity. Keep the ceiling generous for CI hosts.
    expect(elapsedMs).toBeLessThan(30_000);
    console.info(JSON.stringify({
      virtualAgents: agents.length,
      hotRoomAgents: hotAgents.length,
      publishedMessages: 1_000,
      routedDeliveries: hotAgents.length * 1_000,
      retainedPerClient: 1_000,
      clientCacheTransactions: hotAgents.length,
      elapsedMs: Math.round(elapsedMs),
    }));
  }, 30_000);

  it("deduplicates, updates, deletes, and rejects cross-room events", () => {
    const scope = { type: "COHORT", key: "IIT_DELHI|BTECH|GENERAL|2026" };
    const message = { id: "m-1", scope_type: scope.type, scope_key: scope.key, content: "hello", created_at: "2026-08-14T10:00:00.000Z" };
    const inserted = applyForumRealtimeEvent([], { eventType: "INSERT", new: message }, scope);
    const duplicated = applyForumRealtimeEvent(inserted, { eventType: "INSERT", new: message }, scope);
    const updated = applyForumRealtimeEvent(duplicated, { eventType: "UPDATE", new: { ...message, content: "edited" } }, scope);
    const leaked = applyForumRealtimeEvent(updated, { eventType: "INSERT", new: { ...message, id: "other", scope_key: "OTHER" } }, scope);
    const deleted = applyForumRealtimeEvent(leaked, { eventType: "DELETE", old: { id: "m-1" } }, scope);

    expect(inserted).toHaveLength(1);
    expect(duplicated).toHaveLength(1);
    expect(updated[0].content).toBe("edited");
    expect(leaked).toHaveLength(1);
    expect(deleted).toEqual([]);
  });

  it("applies shared reaction totals without erasing viewer-specific reactions", () => {
    const scope = { type: "GLOBAL", key: "IIT_ALL" };
    const current = [{
      id: "reaction-message", scope_type: scope.type, scope_key: scope.key,
      content: "React here", created_at: "2026-08-31T10:00:00.000Z",
      reactions: { "👍": 1 }, myReactions: ["👍"],
    }];

    const next = applyForumRealtimeBatch(current, [{
      eventType: "UPDATE",
      new: {
        id: "reaction-message", scope_type: scope.type, scope_key: scope.key,
        content: "React here", created_at: "2026-08-31T10:00:00.000Z",
        reactions: { "👍": 50 },
      },
    }], scope);

    expect(next[0].reactions).toEqual({ "👍": 50 });
    expect(next[0].myReactions).toEqual(["👍"]);
  });

  it("keeps a 1,500-message IIT Delhi MBA General 2026 conversation ordered and threads isolated", () => {
    const scope = { type: "COHORT", key: "IIT_DELHI|MBA|GENERAL|2026" };
    const rootEvents = Array.from({ length: 1_200 }, (_, sequence) => ({
      eventType: "INSERT" as const,
      new: {
        id: `mba-root-${sequence}`, ...scope, scope_type: scope.type, scope_key: scope.key,
        author_id: `mba-member-${sequence % 24}`, content: `MBA cohort message ${sequence}`,
        created_at: new Date(1_800_100_000_000 + sequence).toISOString(), reply_to_id: null,
      },
    }));
    const threadEvents = Array.from({ length: 300 }, (_, sequence) => ({
      eventType: "INSERT" as const,
      new: {
        id: `mba-reply-${sequence}`, scope_type: scope.type, scope_key: scope.key,
        author_id: `mba-member-${(sequence + 1) % 24}`, content: `Thread reply ${sequence}`,
        created_at: new Date(1_800_100_010_000 + sequence).toISOString(),
        reply_to_id: `mba-root-${sequence % 40}`,
      },
    }));

    const timeline = applyForumRealtimeBatch([], [...rootEvents, ...threadEvents].reverse(), scope, 1_200);
    expect(timeline).toHaveLength(1_200);
    expect(timeline.every((message) => !message.reply_to_id)).toBe(true);
    expect(timeline[0].id).toBe("mba-root-0");
    expect(timeline[1_199].id).toBe("mba-root-1199");
    expect(new Set(timeline.map((message) => message.id)).size).toBe(1_200);
  });
});
