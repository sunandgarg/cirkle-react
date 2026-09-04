import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { executeDataQuery } from "../src/services/data.js";
import { assertDeletableMember } from "../src/services/functions.js";
import { createForumPostsWithSlowMode, resolveForumSlowModeSeconds } from "../src/services/forumSlowMode.js";
import {
  assertConnectionRequestPolicy,
  callRpc,
  CONNECTION_PENDING_LIMIT,
  CONNECTION_RETRY_COOLDOWN_MS,
  CONNECTION_WEEKLY_LIMIT,
} from "../src/services/rpc.js";
import type { RequestContext } from "../src/types.js";

afterEach(() => vi.restoreAllMocks());

const memberContext: RequestContext = {
  auth: { id: "member", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: true },
};
const ownerContext: RequestContext = {
  auth: { id: "owner", email: "owner@example.com", role: "owner", community_id: "iit-community", is_verified: true },
};

describe("Daily entitlement revocation", () => {
  it("ends and deletes active provider rooms when an unverified admin is demoted", async () => {
    const roomName = "cirkle-11111111111141118111111111111111";
    const session = {
      id: "session-record",
      data: { id: "session-1", room_id: "chat-1", daily_room_name: roomName, started_at: new Date().toISOString(), ended_at: null },
    };
    const participant = {
      id: "participant-record",
      data: { id: "participant-1", session_id: "session-1", room_id: "chat-1", user_id: "target", joined_at: new Date().toISOString(), lease_refreshed_at: new Date().toISOString(), left_at: null },
    };
    const updateLegacy = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, data: data.data }));
    const findLegacy = vi.fn().mockImplementation(async (query: any) => {
      if (query.where.table_name === "chat_members") return [{ data: { room_id: "chat-1", user_id: "target" } }];
      if (query.where.table_name === "call_sessions" && query.select?.data) return [session];
      if (query.where.table_name === "call_sessions" && query.select?.id) return [{ id: session.id }];
      if (query.where.id?.in) return [session];
      if (query.where.table_name === "call_participants") return [participant];
      return [];
    });
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: "target" }]),
      user: {
        findUnique: vi.fn().mockResolvedValue({ role: "admin" }),
        update: vi.fn().mockResolvedValue({}),
      },
      profile: {
        findUnique: vi.fn().mockResolvedValue({ is_verified: false }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      legacyRecord: { findMany: findLegacy, update: updateLegacy },
    }));
    vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(callRpc("revoke_admin_role", { p_target_user_id: "target" }, ownerContext)).resolves.toMatchObject({
      updated: true,
      daily_revocation_pending: false,
      daily_revocation_failures: 0,
    });

    expect(provider).toHaveBeenCalledWith(`${"https://api.daily.co/v1/rooms/"}${roomName}`, expect.objectContaining({ method: "DELETE" }));
    expect(updateLegacy.mock.calls.some(([input]) => input.where.id === "session-record" && input.data.data.failure_reason === "admin_role_revoked")).toBe(true);
    expect(updateLegacy.mock.calls.some(([input]) => input.where.id === "participant-record" && input.data.data.left_at)).toBe(true);
  });
});

describe("connection request guardrails", () => {
  it("enforces weekly and pending invitation ceilings", () => {
    expect(() => assertConnectionRequestPolicy({ recentInvitationCount: CONNECTION_WEEKLY_LIMIT, pendingInvitationCount: 0 }))
      .toThrow(/Weekly invitation limit/);
    expect(() => assertConnectionRequestPolicy({ recentInvitationCount: 0, pendingInvitationCount: CONNECTION_PENDING_LIMIT }))
      .toThrow(/outstanding invitations/);
  });

  it("enforces a fresh 21-day cooldown and permits an expired cooldown", () => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    const recent = new Date(now.getTime() - CONNECTION_RETRY_COOLDOWN_MS + 1_000);
    expect(() => assertConnectionRequestPolicy({
      recentInvitationCount: 0, pendingInvitationCount: 0, existing: { status: "declined", created_at: recent }, now,
    })).toThrow(/21 days/);
    expect(() => assertConnectionRequestPolicy({
      recentInvitationCount: 0, pendingInvitationCount: 0,
      existing: { status: "withdrawn", created_at: new Date(now.getTime() - CONNECTION_RETRY_COOLDOWN_MS) }, now,
    })).not.toThrow();
  });

  it("uses a conditional pending-state update so a second response loses the race", async () => {
    vi.spyOn(prisma.profile, "findUnique").mockResolvedValue({ name: "Receiver" } as any);
    const fetchAfterClaim = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      connection: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: fetchAfterClaim },
      legacyRecord: { create: vi.fn() },
    }));
    await expect(callRpc("respond_connection_request", { p_request_id: "request-one", p_accept: true }, memberContext))
      .rejects.toMatchObject({ code: "connection_not_pending" });
    expect(fetchAfterClaim).not.toHaveBeenCalled();
  });

  it("creates a typed request notification inside the guarded send transaction", async () => {
    const peerId = "peer";
    vi.spyOn(prisma.profile, "findUnique")
      .mockResolvedValueOnce({ user_id: peerId, is_verified: true, community_id: "iit-community" } as any)
      .mockResolvedValueOnce({ user_id: memberContext.auth.id, name: "Sending Member" } as any);
    const createNotification = vi.fn().mockResolvedValue({});
    const connection = {
      id: "connection-one", requester_id: memberContext.auth.id, receiver_id: peerId,
      pair_key: "member:peer", status: "pending", note: null, responded_at: null,
      created_at: new Date(), updated_at: new Date(),
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: memberContext.auth.id }, { id: peerId }]),
      connection: {
        count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(connection), update: vi.fn(),
      },
      legacyRecord: { create: createNotification },
    }));

    await expect(callRpc("send_connection_request", { p_receiver_id: peerId }, memberContext)).resolves.toMatchObject(connection);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        owner_id: peerId,
        data: expect.objectContaining({
          type: "connection_request", entity_id: connection.id, link: "/network?tab=pending",
        }),
      }),
    }));
  });
});

describe("forum slow mode", () => {
  it("prefers a scoped setting and safely clamps its interval", () => {
    expect(resolveForumSlowModeSeconds([
      { key: "slow_mode_global", value: JSON.stringify({ enabled: true, seconds: 60 }) },
      { key: "slow_mode_COHORT_IIT_DELHI|BTECH|CSE|2026", value: JSON.stringify({ enabled: true, seconds: 9_999 }) },
    ], "COHORT", "IIT_DELHI|BTECH|CSE|2026")).toBe(3_600);
    expect(resolveForumSlowModeSeconds([
      { key: "slow_mode_global", value: JSON.stringify({ enabled: false, seconds: 60 }) },
    ], "GLOBAL", "IIT_ALL")).toBeNull();
  });

  it("atomically blocks a direct typed-post insert during the configured interval", async () => {
    vi.spyOn(prisma.profile, "findUnique").mockResolvedValue({
      user_id: memberContext.auth.id, iit_name: "IIT Delhi", is_verified: true,
    } as any);
    vi.spyOn(prisma.legacyRecord, "findMany").mockResolvedValue([]);
    const createPost = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: memberContext.auth.id }]),
      user: { findUnique: vi.fn().mockResolvedValue({ id: memberContext.auth.id, role: "member", status: "active" }) },
      profile: { findUnique: vi.fn().mockResolvedValue({ user_id: memberContext.auth.id, iit_name: "IIT Delhi", is_verified: true }) },
      legacyRecord: { findMany: vi.fn().mockImplementation(({ where }: any) => Promise.resolve(
        where.table_name === "app_settings" ? [{
          data: { key: "slow_mode_GLOBAL_IIT_ALL", value: JSON.stringify({ enabled: true, seconds: 30 }) },
        }] : [],
      )) },
      post: {
        findFirst: vi.fn().mockResolvedValue({ created_at: new Date(Date.now() - 1_000) }),
        create: createPost,
      },
    }));

    await expect(executeDataQuery({
      table: "posts", operation: "insert", filters: [], order: [], cardinality: "many",
      values: { content: "Direct insert", scope_type: "GLOBAL", scope_key: "IIT_ALL" },
    }, memberContext)).rejects.toMatchObject({ code: "forum_slow_mode", status: 429 });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("uses the same locked guard for the RPC-compatible post creator", async () => {
    const createPost = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: memberContext.auth.id }]),
      user: { findUnique: vi.fn().mockResolvedValue({ id: memberContext.auth.id, role: "member", status: "active" }) },
      profile: { findUnique: vi.fn().mockResolvedValue({ user_id: memberContext.auth.id, iit_name: "IIT Delhi", is_verified: true }) },
      legacyRecord: { findMany: vi.fn().mockImplementation(({ where }: any) => Promise.resolve(
        where.table_name === "app_settings" ? [{
          data: { key: "slow_mode_GLOBAL_IIT_ALL", value: JSON.stringify({ enabled: true, seconds: 30 }) },
        }] : [],
      )) },
      post: {
        findFirst: vi.fn().mockResolvedValue({ created_at: new Date(Date.now() - 1_000) }),
        create: createPost,
      },
    }));
    await expect(createForumPostsWithSlowMode([{
      author_id: memberContext.auth.id, content: "RPC insert", community_id: "iit-community",
      scope_type: "GLOBAL", scope_key: "IIT_ALL",
    }], memberContext.auth)).rejects.toMatchObject({ code: "forum_slow_mode" });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("rechecks the member's current verified scope under the user lock", async () => {
    const createPost = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: memberContext.auth.id }]),
      user: { findUnique: vi.fn().mockResolvedValue({ id: memberContext.auth.id, role: "member", status: "active" }) },
      profile: { findUnique: vi.fn().mockResolvedValue({ user_id: memberContext.auth.id, iit_name: "IIT Bombay", is_verified: true }) },
      legacyRecord: { findMany: vi.fn().mockImplementation(({ where }: any) => Promise.resolve(
        where.table_name === "verified_academic_affiliations" ? [{ data: {
          id: "affiliation", user_id: memberContext.auth.id, network_id: "IIT",
          institute_id: "IIT_BOMBAY", institute_name: "IIT Bombay", verification_status: "VERIFIED",
        } }] : [],
      )) },
      post: { findFirst: vi.fn(), create: createPost },
    }));

    await expect(createForumPostsWithSlowMode([{
      author_id: memberContext.auth.id, content: "stale scope", community_id: "iit-community",
      scope_type: "CAMPUS", scope_key: "IIT_DELHI",
    }], memberContext.auth)).rejects.toMatchObject({ code: "forum_scope_denied", status: 403 });
    expect(createPost).not.toHaveBeenCalled();
  });
});

describe("privileged account protection", () => {
  it("requires administrators and owners to be demoted before deletion", () => {
    expect(() => assertDeletableMember("owner", { id: "admin", role: "admin" })).toThrow(/demoted/);
    expect(() => assertDeletableMember("owner", { id: "other-owner", role: "owner" })).toThrow(/demoted/);
    expect(() => assertDeletableMember("owner", { id: "legacy-admin", role: "member", profile: { role: "admin" } })).toThrow(/demoted/);
    expect(() => assertDeletableMember("owner", { id: "member", role: "member" })).not.toThrow();
  });

  it("rejects self-deletion and missing targets before any destructive work", () => {
    expect(() => assertDeletableMember("owner", { id: "owner", role: "owner" })).toThrow(/own account/);
    expect(() => assertDeletableMember("owner", null)).toThrow(/not found/);
  });
});

describe("AppSync forum channel authorization", () => {
  it("returns the channel object for one validated requested scope", async () => {
    const ownerContext: RequestContext = {
      auth: { ...memberContext.auth, id: "owner", email: "owner@example.com", role: "owner" },
    };
    const result = await callRpc("get_appsync_forum_channels", {
      p_scope_type: "COHORT_GLOBAL", p_scope_key: "BTECH|Computer Science & Engineering|2026",
    }, ownerContext);
    expect(result).toMatchObject({
      message_channel: expect.stringMatching(/^\/forum\/cohort-global\//),
    });
  });

  it("rejects a requested forum scope outside the member's verified identity", async () => {
    vi.spyOn(prisma.profile, "findUnique").mockResolvedValue({
      user_id: memberContext.auth.id, iit_name: "IIT Delhi", is_verified: true,
    } as any);
    vi.spyOn(prisma.legacyRecord, "findMany").mockResolvedValue([]);
    await expect(callRpc("get_appsync_forum_channels", {
      p_scope_type: "CAMPUS", p_scope_key: "IIT_BOMBAY",
    }, memberContext)).rejects.toMatchObject({ code: "forum_scope_denied" });
  });
});
