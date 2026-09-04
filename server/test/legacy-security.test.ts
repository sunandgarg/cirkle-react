import { describe, expect, it } from "vitest";
import { assertLegacyMutationAllowed, assertPollVotePayload, assertPrivateQuerySafety, assertProfilePatch, blogIsPublic, deriveVirtualUserRoles, eventVisibleToMember, legacyCandidateWhere, normalizeBlogPublishing, pollVoteRecordKey, validatePollOption } from "../src/services/data.js";
import type { RequestContext } from "../src/types.js";
import { applyProfileEntryModeration, assertModeratedProfileWrite, profileEntryVisible, validateModeratedProfileEntry } from "../src/services/moderation.js";
import { trustedForumIdentity } from "../src/security/forumScope.js";
import { assertConsultationTransition } from "../src/services/rpc.js";

const memberContext: RequestContext = {
  auth: { id: "member", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: true },
};

describe("legacy mutation boundaries", () => {
  it.each(["verified_academic_affiliations", "consultations", "user_roles"])("requires a sanctioned workflow for %s", (table) => {
    for (const operation of ["insert", "update", "upsert", "delete"] as const) {
      expect(() => assertLegacyMutationAllowed(table, operation)).toThrowError(/authorized|role-management/i);
    }
  });

  it("allows only read-state updates for notifications", () => {
    expect(() => assertLegacyMutationAllowed("notifications", "update")).not.toThrow();
    expect(() => assertLegacyMutationAllowed("notifications", "insert")).toThrowError(/authorized server workflow/i);
    expect(() => assertLegacyMutationAllowed("notifications", "delete")).toThrowError(/authorized server workflow/i);
  });

  it("derives virtual role rows from the core user role", () => {
    expect(deriveVirtualUserRoles([{ id: "member", role: "member" }, { id: "promoted", role: "admin" }, { id: "root", role: "owner" }])).toEqual([
      { user_id: "member", role: "member" },
      { user_id: "promoted", role: "admin" },
      { user_id: "root", role: "owner" },
      { user_id: "root", role: "admin" },
    ]);
  });

  it("enforces targeted event institute and education audiences", () => {
    const event = { id: "event", status: "published", audience_mode: "targeted", target_iits: ["IIT Delhi"], target_courses: ["B.Tech"], target_specialisations: ["CSE"] };
    const profile = { user_id: "member", is_verified: true, iit_name: "IIT Delhi", primary_education_id: "education" };
    expect(eventVisibleToMember(event, profile, [{ id: "education", degree: "B.Tech", branch_area: "CSE" }])).toBe(true);
    expect(eventVisibleToMember(event, profile, [{ id: "education", degree: "B.Tech", branch_area: "Mechanical" }])).toBe(false);
    expect(eventVisibleToMember(event, { ...profile, is_verified: false }, [{ id: "education", degree: "B.Tech", branch_area: "CSE" }])).toBe(false);
  });

  it("blocks private-profile and anonymous-author query oracles", () => {
    expect(() => assertPrivateQuerySafety({ table: "profiles", filters: [{ column: "phone_full", operator: "eq", value: "+911234567890" }], order: [] }, memberContext))
      .toThrow(/own profile/);
    expect(() => assertPrivateQuerySafety({ table: "profiles", filters: [{ column: "user_id", operator: "eq", value: "member" }, { column: "phone_full", operator: "eq", value: "+911234567890" }], order: [] }, memberContext))
      .not.toThrow();
    expect(() => assertPrivateQuerySafety({ table: "posts", filters: [{ column: "author_id", operator: "eq", value: "another-member" }], order: [] }, memberContext))
      .toThrow(/Anonymous author/);
    expect(() => assertPrivateQuerySafety({ table: "posts", filters: [{ column: "author_id", operator: "eq", value: "another-member" }, { column: "is_anonymous", operator: "eq", value: false }], order: [] }, memberContext))
      .not.toThrow();
  });

  it("applies verified identity and onboarding invariants to profile upserts", () => {
    expect(() => assertProfilePatch({ iit_name: "IIT Bombay" }, { iit_name: "IIT Delhi", is_verified: true }, memberContext)).toThrow(/cannot be changed/);
    expect(() => assertProfilePatch({ student_status: "alumni" }, { student_status: "current_student", is_verified: true }, memberContext)).toThrow(/cannot be changed/);
    expect(() => assertProfilePatch({ onboarding_completed: true }, { is_verified: false, phone_number: "1234567890" }, memberContext)).toThrow(/Verification/);
    expect(() => assertProfilePatch({ onboarding_completed: true }, { is_verified: true, phone_number: "1234567890" }, memberContext)).not.toThrow();
  });
});

describe("moderated profile entries", () => {
  const catalog = [
    { id: "institution-pending", category: "institution", value: "New Institute", status: "pending" as const, owner_id: "member" },
    { id: "branch-approved", category: "branch", value: "Computer Science", status: "approved" as const },
  ];

  it("derives visibility from server-owned catalog state", () => {
    const row = applyProfileEntryModeration("education", {
      user_id: "member", institution: "New Institute", degree: "B.Tech", branch_area: "Computer Science", passing_year: "2028",
    }, catalog, "member");
    expect(row).toMatchObject({ institution_option_id: "institution-pending", branch_option_id: "branch-approved", approval_status: "pending" });
    expect(profileEntryVisible(row, "member", "member", false)).toBe(true);
    expect(profileEntryVisible(row, "member", "another", false)).toBe(false);
  });

  it("blocks forged moderation state and edits to verified education", () => {
    expect(() => assertModeratedProfileWrite("education", { is_verified: true }, undefined, false)).toThrow(/moderation workflow/);
    expect(() => assertModeratedProfileWrite("education", { approval_status: "approved" }, undefined, false)).toThrow(/moderation workflow/);
    expect(() => assertModeratedProfileWrite("education", { degree: "Forged" }, { degree: "B.Tech", is_verified: true }, false)).toThrow(/cannot be edited/);
    expect(() => validateModeratedProfileEntry("professional_experience", { company_name: "Cirkle", start_date: "2026-09-04", end_date: "2025-09-04" })).toThrow(/before/);
  });

  it("does not derive forum cohorts from arbitrary or pending education", () => {
    const profile = { iit_name: "IIT Delhi", is_verified: true };
    const affiliation = { verification_status: "VERIFIED", institute_id: "IIT_DELHI" };
    expect(trustedForumIdentity(profile, affiliation, [{ id: "forged", degree: "Fake", branch_area: "Fake", passing_year: "2028", approval_status: "approved" }]))
      .toMatchObject({ institute: "IIT_DELHI", degree: "", specialisation: "", year: "" });
    expect(trustedForumIdentity(profile, { ...affiliation, source_education_id: "verified" }, [
      { id: "verified", degree: "B.Tech", branch_area: "CSE", passing_year: "2028", is_verified: true, approval_status: "approved" },
    ])).toMatchObject({ degree: "B_TECH", specialisation: "CSE", year: "2028" });
  });
});

describe("poll vote integrity", () => {
  it("uses one deterministic database identity per poll and member", () => {
    expect(pollVoteRecordKey("poll-one", "member")).toBe(pollVoteRecordKey("poll-one", "member"));
    expect(pollVoteRecordKey("poll-one", "member")).not.toBe(pollVoteRecordKey("poll-two", "member"));
  });

  it("accepts only an in-range integer option", () => {
    expect(validatePollOption({ options: ["one", "two"] }, 1)).toBe(1);
    expect(() => validatePollOption({ options: ["one", "two"] }, 2)).toThrow(/invalid/);
    expect(() => validatePollOption({ options: ["one", "two"] }, 0.5)).toThrow(/invalid/);
    expect(() => validatePollOption({ options: ["one", "two"] }, "1")).toThrow(/invalid/);
    expect(() => assertPollVotePayload({ poll_id: "poll", option_index: 0, role: "admin" })).toThrow(/Unsupported/);
  });
});

describe("scheduled blog visibility", () => {
  const now = new Date("2026-09-04T12:00:00.000Z").getTime();

  it("keeps future schedules private and makes due schedules public", () => {
    expect(blogIsPublic({ published: true, status: "scheduled", scheduled_at: "2026-09-04T12:00:01.000Z" }, now)).toBe(false);
    expect(blogIsPublic({ published: true, status: "scheduled", scheduled_at: "2026-09-04T11:59:59.000Z" }, now)).toBe(true);
  });

  it("does not expose drafts or malformed scheduled rows", () => {
    expect(blogIsPublic({ published: true, status: "draft" }, now)).toBe(false);
    expect(blogIsPublic({ published: false, status: "published" }, now)).toBe(false);
    expect(blogIsPublic({ published: true, status: "scheduled", scheduled_at: "invalid" }, now)).toBe(false);
  });

  it("derives coherent publication fields on every write", () => {
    expect(normalizeBlogPublishing({ status: "draft", published: true })).toMatchObject({ status: "draft", published: false, scheduled_at: null });
    expect(normalizeBlogPublishing({ status: "published", published: false, scheduled_at: "2027-01-01" })).toMatchObject({ status: "published", published: true, scheduled_at: null });
    expect(normalizeBlogPublishing({ status: "scheduled", scheduled_at: "2027-01-01T00:00:00Z" })).toMatchObject({ status: "scheduled", published: true, scheduled_at: "2027-01-01T00:00:00.000Z" });
    expect(() => normalizeBlogPublishing({ status: "scheduled" })).toThrow(/valid publication time/);
  });
});

describe("consultation lifecycle", () => {
  it("allows only consultant-led confirmation and completion", () => {
    expect(() => assertConsultationTransition("pending", "confirmed", { isConsultant: true, isAdmin: false })).not.toThrow();
    expect(() => assertConsultationTransition("confirmed", "completed", { isConsultant: true, isAdmin: false })).not.toThrow();
    expect(() => assertConsultationTransition("pending", "confirmed", { isConsultant: false, isAdmin: false })).toThrow(/consultant/i);
    expect(() => assertConsultationTransition("confirmed", "completed", { isConsultant: false, isAdmin: false })).toThrow(/consultant/i);
  });

  it("keeps terminal states terminal and rejects skipped transitions", () => {
    expect(() => assertConsultationTransition("pending", "completed", { isConsultant: true, isAdmin: false })).toThrow(/confirmed/i);
    expect(() => assertConsultationTransition("confirmed", "confirmed", { isConsultant: true, isAdmin: false })).toThrow(/pending/i);
    expect(() => assertConsultationTransition("completed", "cancelled", { isConsultant: true, isAdmin: false })).toThrow(/cannot be changed/i);
    expect(() => assertConsultationTransition("cancelled", "confirmed", { isConsultant: true, isAdmin: false })).toThrow(/cannot be changed/i);
    expect(() => assertConsultationTransition("pending", "cancelled", { isConsultant: false, isAdmin: false })).not.toThrow();
  });
});

describe("chat query scoping", () => {
  it("pushes room and id selection into the database instead of sampling a global window", () => {
    expect(legacyCandidateWhere({ table: "messages", operation: "select", filters: [{ column: "room_id", operator: "eq", value: "room-1" }] }, "member"))
      .toMatchObject({ table_name: "messages", AND: [{ data: { path: "$.room_id", equals: "room-1" } }] });
    expect(legacyCandidateWhere({ table: "messages", operation: "update", filters: [{ column: "id", operator: "eq", value: "message-1" }] }, "member"))
      .toMatchObject({ table_name: "messages", AND: [{ data: { path: "$.id", equals: "message-1" } }] });
  });

  it("allows idempotency lookups only for the authenticated sender and rejects broad message scans", () => {
    expect(() => legacyCandidateWhere({ table: "messages", operation: "select", filters: [
      { column: "sender_id", operator: "eq", value: "someone-else" },
      { column: "client_id", operator: "eq", value: "client-1" },
    ] }, "member")).toThrow(/identify a chat room/i);
    expect(() => legacyCandidateWhere({ table: "messages", operation: "select", filters: [] }, "member")).toThrow(/identify a chat room/i);
  });
});
