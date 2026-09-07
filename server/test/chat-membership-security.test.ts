import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  activeChatAudienceUserIds,
  normalizeActiveChatMembership,
  type ChatMembershipRecord,
} from "../src/realtime/chatMembership.js";
import { executeDataQuery } from "../src/services/data.js";
import { invokeFunction } from "../src/services/functions.js";
import { callRpc } from "../src/services/rpc.js";
import { createSignedUrl } from "../src/services/storage.js";
import type { RequestContext } from "../src/types.js";

const ctx: RequestContext = {
  auth: { id: "member", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: true },
};

const membership = (overrides: Partial<ChatMembershipRecord & { data: Record<string, unknown> }> = {}): ChatMembershipRecord => ({
  id: "membership-one",
  record_id: "source-membership-one",
  owner_id: "member",
  community_id: "iit-community",
  data: { id: "membership-public-one", user_id: "member", room_id: "room-one", ...overrides.data },
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("chat membership transaction fences", () => {
  it("privately archives duplicates and clears every soft-removal marker on explicit reactivation", async () => {
    const candidates = [
      membership({ data: { status: "removed", removed_at: "2026-09-04T00:00:00.000Z", is_active: false } }),
      membership({ id: "membership-two", record_id: "source-membership-two" }),
    ];
    const update = vi.fn().mockImplementation(async ({ where, data }: any) => {
      const current = candidates.find((candidate) => candidate.id === where.id)!;
      return { ...current, ...data, data: data.data ?? current.data };
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue(candidates),
      legacyRecord: { update, create: vi.fn() },
    } as any;

    const active = await normalizeActiveChatMembership(tx, {
      userId: "member", roomId: "room-one", communityId: "iit-community", now: new Date("2026-09-04T01:00:00.000Z"),
    });

    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "membership-two" },
      data: expect.objectContaining({ table_name: "_archived_chat_members", record_id: "membership-two" }),
    }));
    expect(active.data).toMatchObject({
      user_id: "member", room_id: "room-one", status: "active", is_active: true,
    });
    // Imported source identity stays stable so a future full reconciliation is
    // idempotent; exactly-one structural binding is the authorization invariant.
    expect(active.record_id).toBe("source-membership-one");
    expect(active.data).not.toHaveProperty("removed_at");
    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: "membership-one" },
      data: expect.not.objectContaining({ record_id: expect.anything() }),
    }));
  });

  it("rejects message creation when membership is removed before the mutation transaction", async () => {
    const create = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([membership({ data: { status: "removed" } })]),
      legacyRecord: { create },
    }));

    await expect(executeDataQuery({
      table: "messages", operation: "insert", filters: [], order: [], cardinality: "many",
      values: { room_id: "room-one", client_id: "client-one", content: "hello", message_type: "text" },
    }, ctx)).rejects.toMatchObject({ code: "chat_membership_required", status: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it("rechecks membership after selection and blocks a message update after concurrent removal", async () => {
    const messageRecord = {
      id: "message-record", table_name: "messages", record_id: "message-public", owner_id: "member", community_id: "iit-community",
      data: { id: "message-public", room_id: "room-one", sender_id: "member", message_type: "text", content: "before", created_at: new Date().toISOString() },
    };
    vi.spyOn(prisma.legacyRecord, "findMany").mockImplementation(async ({ where }: any) => {
      if (where.table_name === "messages") return [messageRecord] as any;
      if (where.table_name === "chat_members") return [membership()] as any;
      return [];
    });
    const update = vi.fn();
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: messageRecord.id }])
      .mockResolvedValueOnce([membership({ data: { status: "revoked" } })]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { findUnique: vi.fn().mockResolvedValue(messageRecord), update },
    }));

    await expect(executeDataQuery({
      table: "messages", operation: "update",
      filters: [{ column: "id", operator: "eq", value: "message-public" }], order: [], cardinality: "many",
      values: { content: "after" },
    }, ctx)).rejects.toMatchObject({ code: "chat_membership_required", status: 403 });
    expect(update).not.toHaveBeenCalled();
  });

  it("locks and reloads mark-read membership so cursor updates cannot resurrect removal", async () => {
    const update = vi.fn();
    const queryRaw = vi.fn().mockResolvedValue([membership({ data: { status: "removed" } })]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { update },
    }));

    await expect(callRpc("mark_chat_read", { p_room_id: "room-one" }, ctx))
      .rejects.toMatchObject({ code: "chat_membership_required", status: 403 });
    expect(queryRaw.mock.calls[0]?.[0]?.sql).toContain("FOR UPDATE");
    expect(queryRaw.mock.calls[0]?.[0]?.sql).not.toContain("FOR SHARE");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a call-participant heartbeat when membership is removed inside the mutation transaction", async () => {
    const now = new Date();
    const participant = {
      id: "participant-record", table_name: "call_participants", record_id: "participant-source",
      owner_id: "member", community_id: "iit-community",
      data: {
        id: "participant-public", user_id: "member", session_id: "session-one", room_id: "room-one",
        joined_at: now.toISOString(), lease_refreshed_at: now.toISOString(), left_at: null,
      },
    };
    vi.spyOn(prisma.legacyRecord, "findMany").mockImplementation(async ({ where }: any) => {
      if (where.table_name === "call_participants") return [participant] as any;
      if (where.table_name === "chat_members") return [membership()] as any;
      return [];
    });
    const update = vi.fn();
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: "session-record" }])
      .mockResolvedValueOnce([{ id: participant.id }])
      .mockResolvedValueOnce([membership({ data: { status: "removed" } })]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { findUnique: vi.fn().mockResolvedValue(participant), update },
    }));

    await expect(executeDataQuery({
      table: "call_participants", operation: "update",
      filters: [{ column: "id", operator: "eq", value: "participant-public" }], order: [], cardinality: "many",
      values: { lease_refreshed_at: now.toISOString() },
    }, ctx)).rejects.toMatchObject({ code: "call_membership_required", status: 403 });
    expect(update).not.toHaveBeenCalled();
  });

  it("does not expose or update a heartbeat target when membership was already removed", async () => {
    const now = new Date();
    const participant = {
      id: "participant-record", table_name: "call_participants", record_id: "participant-source",
      owner_id: "member", community_id: "iit-community",
      data: {
        id: "participant-public", user_id: "member", session_id: "session-one", room_id: "room-one",
        joined_at: now.toISOString(), lease_refreshed_at: now.toISOString(), left_at: null,
      },
    };
    vi.spyOn(prisma.legacyRecord, "findMany").mockImplementation(async ({ where }: any) => {
      if (where.table_name === "call_participants") return [participant] as any;
      if (where.table_name === "chat_members") return [membership({ data: { status: "removed" } })] as any;
      return [];
    });
    const transaction = vi.spyOn(prisma, "$transaction");

    await expect(executeDataQuery({
      table: "call_participants", operation: "update",
      filters: [{ column: "id", operator: "eq", value: "participant-public" }], order: [], cardinality: "many",
      values: { lease_refreshed_at: now.toISOString() },
    }, ctx)).resolves.toEqual({ data: [] });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still allows a removed member to idempotently leave an existing call participant", async () => {
    const now = new Date();
    const participant = {
      id: "participant-record", table_name: "call_participants", record_id: "participant-source",
      owner_id: "member", community_id: "iit-community",
      data: {
        id: "participant-public", user_id: "member", session_id: "session-one", room_id: "room-one",
        joined_at: now.toISOString(), lease_refreshed_at: now.toISOString(), left_at: null,
      },
    };
    vi.spyOn(prisma.legacyRecord, "findMany").mockImplementation(async ({ where }: any) => {
      if (where.table_name === "call_participants") return [participant] as any;
      if (where.table_name === "chat_members") return [membership({ data: { status: "removed" } })] as any;
      return [];
    });
    const update = vi.fn().mockImplementation(async ({ data }: any) => ({
      ...participant,
      data: data.data,
    }));
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: "session-record" }])
      .mockResolvedValueOnce([{ id: participant.id }]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { findUnique: vi.fn().mockResolvedValue(participant), update },
    }));

    await expect(executeDataQuery({
      table: "call_participants", operation: "update",
      filters: [{ column: "id", operator: "eq", value: "participant-public" }], order: [], cardinality: "many",
      values: { left_at: "client-value-is-ignored" },
    }, ctx)).resolves.toMatchObject({ data: [expect.objectContaining({ id: "participant-public" })] });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.data.left_at).not.toBeNull();
  });
});

describe("direct chat and inbox membership policy", () => {
  it("excludes a removed peer from the room audience", () => {
    const peerMembership = membership({
      id: "membership-peer", record_id: "source-membership-peer", owner_id: "peer",
      data: { id: "membership-public-peer", user_id: "peer", room_id: "room-one", status: "removed" },
    });

    expect(activeChatAudienceUserIds([membership(), peerMembership], "room-one")).toEqual(["member"]);
  });

  it("reactivates both peers only through the accepted direct-chat RPC", async () => {
    const peerMembership = membership({
      id: "membership-peer", record_id: "source-membership-peer", owner_id: "peer",
      data: { id: "membership-public-peer", user_id: "peer", room_id: "room-one", left_at: "2026-09-04T00:00:00.000Z" },
    });
    const update = vi.fn().mockImplementation(async ({ where, data }: any) => {
      const current = where.id === "membership-peer" ? peerMembership : membership();
      return { ...current, ...data, data: data.data ?? current.data };
    });
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: "connection-one" }])
      .mockResolvedValueOnce([{ id: "room-record" }])
      .mockResolvedValueOnce([membership({ data: { status: "removed" } })])
      .mockResolvedValueOnce([peerMembership]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      connection: { findUnique: vi.fn().mockResolvedValue({ requester_id: "member", receiver_id: "peer", status: "accepted" }) },
      legacyRecord: {
        findUnique: vi.fn().mockResolvedValue({
          id: "room-record", data: { id: "room-one", direct_key: "member:peer", is_group: false },
        }),
        update,
        create: vi.fn(),
      },
    }));

    await expect(callRpc("get_or_create_direct_chat", { p_peer_id: "peer" }, ctx)).resolves.toBe("room-one");
    expect(update).toHaveBeenCalledTimes(2);
    for (const call of update.mock.calls) {
      expect(call[0].data.data).toMatchObject({ status: "active", is_active: true, room_id: "room-one" });
      expect(call[0].data.data).not.toHaveProperty("left_at");
      expect(call[0].data.data).not.toHaveProperty("removed_at");
    }
  });

  it.each([
    ["ambiguous duplicate", [membership(), membership({ id: "membership-two", record_id: "source-membership-two" })]],
    ["soft-removed", [membership({ data: { is_active: false, status: "removed" } })]],
    ["JSON-null", [{ ...membership(), data: null }]],
  ])("omits a %s membership before running unread SQL", async (_case, records) => {
    const queryRaw = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { findMany: vi.fn().mockResolvedValue(records as any) },
    }));

    await expect(callRpc("get_chat_inbox", {}, ctx)).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("revalidates a snapshotted membership before any inbox content read when removal wins the race", async () => {
    let signalLockStarted!: () => void;
    const lockStarted = new Promise<void>((resolve) => { signalLockStarted = resolve; });
    let returnRevokedMembership!: () => void;
    const revokedMembership = new Promise<ChatMembershipRecord[]>((resolve) => {
      returnRevokedMembership = () => resolve([membership({ data: { status: "removed" } })]);
    });
    const findMany = vi.fn()
      .mockResolvedValueOnce([membership()])
      .mockResolvedValueOnce([]);
    const queryRaw = vi.fn().mockImplementationOnce(async () => {
      signalLockStarted();
      return revokedMembership;
    });
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { findMany },
    }));

    const inbox = callRpc("get_chat_inbox", {}, ctx);
    await lockStarted;

    // Discovery saw the old active row, but room/message reads cannot start
    // while current membership is waiting to be locking-read and revalidated.
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0]?.[0]?.sql).toContain("FOR SHARE");

    returnRevokedMembership();
    await expect(inbox).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("keeps room, summary, and latest-message materialization on the fenced transaction client", async () => {
    const roomRecord = {
      id: "room-record", data: { id: "room-one", is_group: false, direct_key: "member:peer" },
    };
    const messageRecord = {
      id: "message-record", data: {
        id: "message-one", room_id: "room-one", sender_id: "peer", content: "hello",
        created_at: "2026-09-04T01:00:00.000Z",
      },
    };
    const findMany = vi.fn()
      .mockResolvedValueOnce([membership()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([roomRecord])
      .mockResolvedValueOnce([messageRecord]);
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([membership()])
      .mockResolvedValueOnce([{ id: "message-record", room_id: "room-one" }])
      .mockResolvedValueOnce([{ room_id: "room-one", unread_count: 1n }]);
    const globalFindMany = vi.spyOn(prisma.legacyRecord, "findMany");
    const globalQueryRaw = vi.spyOn(prisma, "$queryRaw");
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { findMany },
    }));

    await expect(callRpc("get_chat_inbox", {}, ctx)).resolves.toEqual([
      expect.objectContaining({
        id: "room-one", room_id: "room-one", direct_key: "member:peer", unread_count: 1,
        last_message: expect.objectContaining({ id: "message-one", content: "hello" }),
      }),
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(findMany).toHaveBeenCalledTimes(4);
    expect(globalFindMany).not.toHaveBeenCalled();
    expect(globalQueryRaw).not.toHaveBeenCalled();
  });

  it("returns peer identity for an accepted direct room before its first message", async () => {
    const roomRecord = {
      id: "room-record", data: { id: "room-one", is_group: false, direct_key: "member:peer" },
    };
    const findMany = vi.fn()
      .mockResolvedValueOnce([membership()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([roomRecord]);
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([membership()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: { findMany },
    }));
    vi.spyOn(prisma.connection, "findMany").mockResolvedValue([{
      id: "connection-one", requester_id: "member", receiver_id: "peer",
      pair_key: "member:peer", status: "accepted", note: null,
      created_at: new Date(), responded_at: new Date(),
    }] as any);
    vi.spyOn(prisma.profile, "findMany").mockResolvedValue([{
      user_id: "peer", name: "QA Recipient", avatar_url: null,
    }] as any);

    await expect(callRpc("get_direct_message_sidebar", {}, ctx)).resolves.toEqual([
      expect.objectContaining({
        connection_id: "connection-one", peer_id: "peer", room_id: "room-one",
        display_name: "QA Recipient", last_message: null, unread_count: 0,
      }),
    ]);
  });

  it("reactivates only the confirmed consultation participants and clears their removal markers", async () => {
    const memberMembership = membership({ data: { status: "removed", removed_at: "2026-09-04T00:00:00.000Z" } });
    const peerMembership = membership({
      id: "membership-peer", record_id: "source-membership-peer", owner_id: "peer",
      data: { id: "membership-public-peer", user_id: "peer", room_id: "room-one", left_at: "2026-09-04T00:00:00.000Z" },
    });
    const roomRecord = {
      id: "room-record", record_id: "consult:consult-one", owner_id: null, community_id: "iit-community",
      data: { id: "room-one", consultation_id: "consult-one", is_group: false },
    };
    const consultation = {
      id: "consultation-record",
      data: {
        id: "consult-one", client_id: "member", consultant_id: "peer", status: "confirmed", chat_room_id: "room-one",
      },
    };
    const update = vi.fn().mockImplementation(async ({ where, data }: any) => {
      if (where.id === memberMembership.id) return { ...memberMembership, ...data, data: data.data ?? memberMembership.data };
      if (where.id === peerMembership.id) return { ...peerMembership, ...data, data: data.data ?? peerMembership.data };
      return { ...consultation, ...data, data: data.data ?? consultation.data };
    });
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([consultation])
      .mockResolvedValueOnce([{ id: roomRecord.id }])
      .mockResolvedValueOnce([memberMembership])
      .mockResolvedValueOnce([peerMembership]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: queryRaw,
      legacyRecord: {
        findUnique: vi.fn().mockResolvedValue(roomRecord),
        findMany: vi.fn().mockResolvedValue([roomRecord]),
        update,
        create: vi.fn(),
      },
    }));

    await expect(invokeFunction("create-consult-chat", { consultation_id: "consult-one" }, ctx, {}))
      .resolves.toMatchObject({ payload: { room_id: "room-one" } });
    const membershipUpdates = update.mock.calls.filter(([input]) =>
      input.where.id === memberMembership.id || input.where.id === peerMembership.id);
    expect(membershipUpdates).toHaveLength(2);
    for (const [input] of membershipUpdates) {
      expect(input.data.data).toMatchObject({ room_id: "room-one", status: "active", is_active: true });
      expect(input.data.data).not.toHaveProperty("removed_at");
      expect(input.data.data).not.toHaveProperty("left_at");
    }
  });
});

describe("chat attachment authorization", () => {
  const readyChatFile = () => ({
    id: "file-one", object_key: "chat-media/member/photo.webp", bucket: "chat-media", uploaded_by: "member",
    original_name: "photo.webp", mime_type: "image/webp", size_bytes: 100, visibility: "private", status: "ready",
    sha256: "digest", deleted_at: null, created_at: new Date(), updated_at: new Date(),
  });

  it("does not let more than twenty tombstoned decoys hide an active attachment from a removed uploader", async () => {
    vi.spyOn(prisma.fileObject, "findUnique").mockResolvedValue({
      ...readyChatFile(),
    } as any);
    const messages = [
      ...Array.from({ length: 20 }, (_, index) => ({
        data: {
          room_id: `decoy-room-${index}`, media_path: "member/photo.webp", media_bucket: "chat-media",
          is_deleted_for_everyone: true,
        },
      })),
      { data: { room_id: "room-one", media_path: "member/photo.webp", media_bucket: "chat-media", is_deleted_for_everyone: false } },
    ];
    const findMany = vi.spyOn(prisma.legacyRecord, "findMany").mockImplementation(async ({ where, take }: any) => {
      if (where.table_name === "messages") return messages.slice(0, take ?? messages.length) as any;
      if (where.table_name === "chat_members") return [membership({ data: { status: "removed" } })] as any;
      return [];
    });

    await expect(createSignedUrl("chat-media", "member/photo.webp", 300, ctx))
      .rejects.toMatchObject({ code: "file_access_denied", status: 403 });
    const referenceQueries = findMany.mock.calls
      .map(([input]) => input)
      .filter((input) => input.where.table_name === "messages");
    expect(referenceQueries).toHaveLength(2);
    expect(referenceQueries).toEqual([expect.not.objectContaining({ take: expect.anything() }), expect.not.objectContaining({ take: expect.anything() })]);
  });

  it("does not let one hundred tombstones make a surviving attachment look globally revoked", async () => {
    vi.spyOn(prisma.fileObject, "findUnique").mockResolvedValue(readyChatFile() as any);
    const messages = [
      ...Array.from({ length: 100 }, (_, index) => ({
        data: {
          room_id: `decoy-room-${index}`, media_path: "member/photo.webp", media_bucket: "chat-media",
          is_deleted_for_everyone: true,
        },
      })),
      { data: { room_id: "room-one", media_path: "member/photo.webp", media_bucket: "chat-media", is_deleted_for_everyone: false } },
    ];
    vi.spyOn(prisma.legacyRecord, "findMany").mockImplementation(async ({ where, take }: any) => {
      if (where.table_name === "messages") return messages.slice(0, take ?? messages.length) as any;
      if (where.table_name === "chat_members") return [membership()] as any;
      return [];
    });

    await expect(createSignedUrl("chat-media", "member/photo.webp", 300, ctx))
      .resolves.toContain("/api/storage/private/chat-media/member/photo.webp");
  });
});
