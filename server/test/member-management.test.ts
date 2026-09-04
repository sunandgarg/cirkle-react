import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { realtimeEvents, type DbChangeEvent } from "../src/realtime/events.js";
import {
  invokeFunction,
  managedMemberAcademicInput,
  resolveMemberFileDiskPath,
} from "../src/services/functions.js";
import type { RequestContext } from "../src/types.js";

const ownerContext: RequestContext = {
  auth: {
    id: "owner-user",
    email: "owner@example.com",
    role: "owner",
    community_id: "iit-community",
    is_verified: true,
  },
  ip: "127.0.0.1",
};

afterEach(() => vi.restoreAllMocks());

describe("managed member provisioning", () => {
  it("validates the shared ten-character password floor", () => {
    expect(() => managedMemberAcademicInput({
      email: "new@example.com",
      password: "123456789",
      name: "New Member",
      iit_name: "IIT Bombay",
      degree: "BTech",
      specialisation: "Aerospace Engineering",
      graduation_year: 2030,
      student_status: "current_student",
    })).toThrow(/between 10 and 128/);
  });

  it("creates the profile, verified education and affiliation in one transaction", async () => {
    const createLegacy = vi.fn().mockResolvedValue({});
    const createUser = vi.fn().mockResolvedValue({ id: "new-user", email: "new@example.com" });
    const createAudit = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      user: { create: createUser },
      legacyRecord: { create: createLegacy },
      auditLog: { create: createAudit },
    }));

    const result = await invokeFunction("manage-users", {
      action: "create_member",
      email: "NEW@EXAMPLE.COM",
      password: "secure-pass-123",
      name: "New Member",
      iit_name: "IIT Bombay",
      degree: "BTech",
      specialisation: "Aerospace Engineering",
      graduation_year: 2030,
      student_status: "alumni",
    }, ownerContext, {});

    const profile = createUser.mock.calls[0]![0].data.profile.create;
    const education = createLegacy.mock.calls.find((call) => call[0].data.table_name === "education")![0].data;
    const affiliation = createLegacy.mock.calls.find((call) => call[0].data.table_name === "verified_academic_affiliations")![0].data;
    expect(result.payload).toMatchObject({ user_id: "new-user", education_id: education.data.id, created: true });
    expect(createUser.mock.calls[0]![0].data).toMatchObject({
      email: "new@example.com",
      status: "active",
      profile: { create: {
        name: "New Member",
        iit_name: "IIT Bombay",
        student_status: "alumni",
        primary_education_id: education.data.id,
      } },
    });
    expect(education).toMatchObject({
      owner_id: "new-user",
      data: {
        institution: "IIT Bombay",
        degree: "BTech",
        branch_area: "Aerospace Engineering",
        passing_year: "2030",
        is_verified: true,
        approval_status: "approved",
      },
    });
    expect(affiliation).toMatchObject({
      owner_id: "new-user",
      data: {
        institute_id: "IIT_BOMBAY",
        degree_id: "BTECH",
        specialisation_id: "AEROSPACE_ENGINEERING",
        graduation_year: 2030,
        student_status: "alumni",
        member_status: "alumni",
        verification_status: "VERIFIED",
        source_education_id: education.data.id,
      },
    });
    expect(profile.primary_education_id).toBe(education.data.id);
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "admin.create_member", resource_id: "new-user" }),
    }));
  }, 15_000);
});

describe("managed member deletion", () => {
  it("deletes both sides of direct-room membership before removing the account", async () => {
    const deleteLegacy = vi.fn().mockResolvedValue({ count: 1 });
    const findLegacy = vi.fn().mockImplementation(async (query: any) => {
      if (query.where.table_name === "chat_members") {
        return [{ id: "member-record", owner_id: "target-user", data: { room_id: "room-one", user_id: "target-user" } }];
      }
      if (query.where.table_name === "chat_rooms" && query.where.data?.path === "$.created_by") return [];
      if (query.where.table_name === "chat_rooms") {
        return [{ id: "room-record", owner_id: null, data: { id: "room-one", is_group: false, created_by: "survivor-user" } }];
      }
      return [];
    });
    const deleteUser = vi.fn().mockResolvedValue({ count: 1 });
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: "target-user" }]),
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "target-user",
          email: "target@example.com",
          role: "member",
          profile: { name: "Target Member", role: "member" },
        }),
        deleteMany: deleteUser,
      },
      fileObject: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      legacyRecord: { findMany: findLegacy, deleteMany: deleteLegacy, update: vi.fn() },
      post: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      comment: { updateMany: vi.fn() },
      reaction: { deleteMany: vi.fn() },
      report: { deleteMany: vi.fn() },
      job: { deleteMany: vi.fn() },
      event: { deleteMany: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    }));

    const result = await invokeFunction("manage-users", {
      action: "delete_member",
      user_id: "target-user",
      confirmation: "Target Member",
    }, ownerContext, {});

    expect(result.payload).toMatchObject({
      user_id: "target-user",
      deleted: true,
      direct_rooms_deleted: 1,
      storage_cleanup_pending: false,
    });
    expect(deleteLegacy.mock.calls.some((call) => {
      const where = call[0].where;
      return where.table_name?.in?.includes("chat_members") && JSON.stringify(where).includes("room-one");
    })).toBe(true);
    expect(deleteLegacy).toHaveBeenCalledWith({ where: { id: { in: ["room-record"] } } });
    expect(deleteUser).toHaveBeenCalledWith({ where: { id: "target-user", role: { notIn: ["admin", "owner"] } } });
  });

  it("reassigns an approved shared catalog option instead of deleting it with its submitter", async () => {
    const updateLegacy = vi.fn().mockResolvedValue({});
    const deleteLegacy = vi.fn().mockResolvedValue({ count: 0 });
    const approved = {
      id: "catalog-record", owner_id: "target-user",
      data: { id: "option-one", category: "company", value: "Shared Company", status: "approved", created_by: "target-user", submitted_by: "target-user" },
    };
    const findLegacy = vi.fn().mockImplementation(async (query: any) => {
      if (query.where.table_name === "custom_options" && query.where.owner_id === "target-user") return [approved];
      if (query.where.table_name?.in) return [{ table_name: "custom_options", owner_id: "target-user", data: approved.data }];
      return [];
    });
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: "target-user" }]),
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "target-user", email: "target@example.com", role: "member", profile: { name: "Target Member", role: "member" } }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      fileObject: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      legacyRecord: { findMany: findLegacy, deleteMany: deleteLegacy, update: updateLegacy },
      post: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      comment: { updateMany: vi.fn() },
      reaction: { deleteMany: vi.fn() }, report: { deleteMany: vi.fn() }, job: { deleteMany: vi.fn() }, event: { deleteMany: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    }));

    await invokeFunction("manage-users", {
      action: "delete_member", user_id: "target-user", confirmation: "Target Member",
    }, ownerContext, {});

    expect(updateLegacy).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "catalog-record" },
      data: expect.objectContaining({ owner_id: null, data: expect.objectContaining({ id: "option-one", status: "approved", created_by: null, submitted_by: null }) }),
    }));
  });

  it("never resolves an owned file outside the configured storage root", () => {
    const root = "/srv/cirkle/storage";
    expect(resolveMemberFileDiskPath(root, "avatars/user/avatar.webp"))
      .toBe(path.join(root, "avatars/user/avatar.webp"));
    expect(() => resolveMemberFileDiskPath(root, "../../etc/passwd")).toThrow(/outside the storage root/);
    expect(() => resolveMemberFileDiskPath(root, "/etc/passwd")).toThrow(/stored upload path is invalid/);
  });

  it("reports an upload cleanup failure after the account transaction instead of hiding it", async () => {
    const order: string[] = [];
    vi.spyOn(prisma, "$transaction").mockResolvedValue({
      files: [{ id: "bad-file", object_key: "../../outside" }],
      directRoomsDeleted: 0,
      postsDeleted: 0,
    } as any);
    const updateFiles = vi.spyOn(prisma.fileObject, "updateMany").mockImplementation(async () => {
      order.push("storage-cleanup");
      return { count: 1 };
    });
    vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);
    const lifecycleListener = (change: DbChangeEvent) => {
      if (change.table === "profiles" && change.row.user_id === "target-user" && change.row.force_reauthenticate === true) {
        order.push("realtime-disconnect");
      }
    };
    realtimeEvents.on("db-change", lifecycleListener);

    let result;
    try {
      result = await invokeFunction("manage-users", {
        action: "delete_member",
        user_id: "target-user",
        confirmation: "Target Member",
      }, ownerContext, {});
    } finally {
      realtimeEvents.off("db-change", lifecycleListener);
    }

    expect(result.payload).toMatchObject({
      deleted: true,
      files_removed: 0,
      storage_cleanup_pending: true,
      storage_cleanup_failures: 1,
    });
    expect(updateFiles).toHaveBeenCalledWith({
      where: { id: { in: ["bad-file"] } },
      data: { status: "cleanup_failed" },
    });
    expect(order).toEqual(["realtime-disconnect", "storage-cleanup"]);
  });
});
