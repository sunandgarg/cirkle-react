import { describe, expect, it } from "vitest";
import { assertCommentParent, assertCoreDeleteAllowed, assertCoreUpdateRelationsImmutable, assertCoreUpsertRelationsUnchanged, assertLegacyMutationAllowed, assertPollVotePayload, assertPostReferenceScope, assertPrivateQuerySafety, assertProfilePatch, blogIsPublic, commentTombstonePatch, deriveVirtualUserRoles, eventVisibleToMember, legacyCandidateWhere, legacyTableRequiresVerification, normalizeBlogAffinityShape, normalizeBlogPublishing, normalizeCallParticipantCreate, normalizeCallParticipantUpdate, normalizeCallSessionFinalization, normalizeMessageUpdatePatch, normalizeNewBlogCommentShape, normalizeNewMessageShape, pollRecordKey, pollVoteRecordKey, publicLegacyRow, validatePollOption } from "../src/services/data.js";
import type { RequestContext } from "../src/types.js";
import { applyProfileEntryModeration, assertModeratedProfileWrite, profileEntryVisible, validateModeratedProfileEntry } from "../src/services/moderation.js";
import { trustedForumIdentity } from "../src/security/forumScope.js";
import { assertConsultationTransition } from "../src/services/rpc.js";

const memberContext: RequestContext = {
  auth: { id: "member", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: true },
};

describe("legacy mutation boundaries", () => {
  it("requires verified membership for protected community interactions", () => {
    for (const table of ["stories", "polls", "poll_votes", "blog_comments", "blog_likes", "blog_bookmarks", "messages"]) {
      expect(legacyTableRequiresVerification(table)).toBe(true);
    }
    expect(legacyTableRequiresVerification("notifications")).toBe(false);
  });
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

  it("does not let ordinary updates move rows onto new protected targets", () => {
    expect(() => assertCoreUpdateRelationsImmutable("comments", { post_id: "another-post" })).toThrow(/cannot be changed/);
    expect(() => assertCoreUpdateRelationsImmutable("applications", { job_id: "another-job" })).toThrow(/cannot be changed/);
    expect(() => assertCoreUpdateRelationsImmutable("rsvps", { event_id: "another-event" })).toThrow(/cannot be changed/);
    expect(() => assertCoreUpdateRelationsImmutable("posts", { scope_key: "another-scope" })).toThrow(/cannot be changed/);
    expect(() => assertCoreUpdateRelationsImmutable("comments", { content: "edited" })).not.toThrow();
    expect(() => assertCoreUpsertRelationsUnchanged("comments", { post_id: "original", content: "edited" }, { post_id: "original" })).not.toThrow();
    expect(() => assertCoreUpsertRelationsUnchanged("comments", { post_id: "another" }, { post_id: "original" })).toThrow(/cannot be changed/);
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
    expect(() => assertPrivateQuerySafety({ table: "posts", filters: [{ column: "image_path", operator: "eq", value: "another-member/private.webp" }], order: [] }, memberContext))
      .toThrow(/Anonymous author/);
    expect(() => assertPrivateQuerySafety({ table: "posts", filters: [{ column: "client_id", operator: "eq", value: "reused-client-id" }], order: [] }, memberContext))
      .toThrow(/Anonymous author/);
    expect(() => assertPrivateQuerySafety({ table: "posts", filters: [{ column: "is_anonymous", operator: "eq", value: false }], order: [{ column: "file_name", ascending: true }] }, memberContext))
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

  it("keeps unreferenced free-text profile values private", () => {
    const row = applyProfileEntryModeration("professional_experience", {
      company_name: "Unreviewed Company",
      location: "Unreviewed City",
    }, [], "member");
    expect(row.approval_status).toBe("pending");
    expect(profileEntryVisible(row, "member", "another", false)).toBe(false);
    expect(profileEntryVisible(row, "member", "member", false)).toBe(true);
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
  it("derives one server-owned poll identity from its post", () => {
    expect(pollRecordKey("post-one")).toBe(pollRecordKey("post-one"));
    expect(pollRecordKey("post-one")).not.toBe(pollRecordKey("post-two"));
  });
  it("never exposes an anonymous poll creator through the public poll payload", () => {
    expect(publicLegacyRow("polls", { id: "poll", post_id: "post", created_by: "secret-member", question: "Question?" }))
      .toEqual({ id: "poll", post_id: "post", question: "Question?" });
  });
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

describe("legacy compatibility query scoping", () => {
  it("pushes exact scalar owner filters into MySQL without a global row window", () => {
    expect(legacyCandidateWhere({
      table: "notifications", operation: "select",
      filters: [{ column: "user_id", operator: "eq", value: "member-1" }],
    }, "member-1")).toEqual({
      table_name: "notifications",
      AND: [{ data: { path: "$.user_id", equals: "member-1" } }],
    });
  });

  it("does not turn non-scalar or non-exact filters into database JSON paths", () => {
    expect(legacyCandidateWhere({
      table: "custom_options", operation: "select",
      filters: [{ column: "value", operator: "ilike", value: "%IIT%" }],
    }, "member-1")).toEqual({ table_name: "custom_options" });
  });
});

describe("chat message creation shape", () => {
  it("replaces client-authored identity, dates, state, and read receipts", () => {
    const row = normalizeNewMessageShape({
      room_id: "room-123", client_id: "client-123", content: " Hello ", message_type: "text",
      sender_id: "attacker", created_at: "invalid", status: "admin", read_by: ["attacker"],
    }, "member-1", new Date("2026-09-04T00:00:00.000Z"));
    expect(row).toMatchObject({
      room_id: "room-123", client_id: "client-123", content: "Hello", message_type: "text",
      sender_id: "member-1", created_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:00.000Z",
      status: "sent", read_by: ["member-1"], media_path: null, media_bucket: null,
    });
  });

  it("rejects malformed, empty, mismatched, and forged media messages", () => {
    const base = { room_id: "room-123", client_id: "client-123" };
    expect(() => normalizeNewMessageShape({ ...base, content: {} }, "member-1")).toThrow(/text is required/i);
    expect(() => normalizeNewMessageShape({ ...base, content: "hello", message_type: "system" }, "member-1")).toThrow(/text, image, or voice/i);
    expect(() => normalizeNewMessageShape({ ...base, content: "hello", media_path: "member/file.webp" }, "member-1")).toThrow(/cannot include/i);
    expect(() => normalizeNewMessageShape({ ...base, message_type: "image" }, "member-1")).toThrow(/uploaded file/i);
    expect(() => normalizeNewMessageShape({ ...base, message_type: "voice", media_path: "member/voice.webm", voice_duration: 0 }, "member-1")).toThrow(/duration/i);
  });
});

describe("chat message update shape", () => {
  const current = {
    id: "message-1", sender_id: "member-1", room_id: "room-1", message_type: "text",
    content: "before", created_at: "2026-09-04T00:00:00.000Z", is_deleted_for_everyone: false,
  };

  it("uses server time and accepts only bounded string text edits", () => {
    expect(normalizeMessageUpdatePatch(current, { content: " after ", edited_at: "forged" }, "member-1", false, new Date("2026-09-04T00:01:00.000Z")))
      .toEqual({ content: "after", edited_at: "2026-09-04T00:01:00.000Z" });
    expect(() => normalizeMessageUpdatePatch(current, { content: null }, "member-1")).toThrow(/text is required/i);
    expect(() => normalizeMessageUpdatePatch(current, { content: "ok", read_by: ["attacker"] }, "member-1")).toThrow(/Only text editing/i);
  });

  it("creates a server-owned tombstone only inside the three-minute window", () => {
    const deleted = normalizeMessageUpdatePatch(current, { is_deleted_for_everyone: true }, "member-1", false, new Date("2026-09-04T00:02:59.000Z"));
    expect(deleted).toMatchObject({ content: "", is_deleted_for_everyone: true, deleted_for_everyone: true, deleted_at: "2026-09-04T00:02:59.000Z" });
    expect(() => normalizeMessageUpdatePatch(current, { is_deleted_for_everyone: true }, "member-1", false, new Date("2026-09-04T00:03:01.000Z"))).toThrow(/after 3 minutes/i);
    expect(() => normalizeMessageUpdatePatch(current, { is_deleted_for_everyone: true, content: "replace" }, "member-1", false, new Date("2026-09-04T00:01:00.000Z"))).toThrow(/cannot be combined/i);
  });
});

describe("call participant state", () => {
  it("derives participant identity, room, and timestamps from an active session", () => {
    expect(normalizeCallParticipantCreate({
      id: "session-1", room_id: "room-1", started_at: "2026-09-04T00:00:00.000Z", ended_at: null,
    }, "member-1", new Date("2026-09-04T00:04:59.000Z"))).toMatchObject({
      session_id: "session-1", room_id: "room-1", user_id: "member-1",
      joined_at: "2026-09-04T00:04:59.000Z", lease_refreshed_at: "2026-09-04T00:04:59.000Z", left_at: null,
    });
    expect(() => normalizeCallParticipantCreate({
      id: "session-1", room_id: "room-1", started_at: "2026-09-04T00:00:00.000Z", ended_at: null,
    }, "member-1", new Date("2026-09-04T00:05:01.000Z"))).toThrow(/no longer/i);
    expect(normalizeCallParticipantCreate({
      id: "session-1", room_id: "room-1", started_at: "2026-09-04T00:00:00.000Z", ended_at: null,
    }, "member-2", new Date("2026-09-04T00:30:00.000Z"), true)).toMatchObject({
      session_id: "session-1", room_id: "room-1", user_id: "member-2",
    });
  });

  it("allows only server-timestamped heartbeat or leave changes on the caller's participant row", () => {
    const current = { user_id: "member-1", left_at: null, lease_refreshed_at: "2026-09-04T00:04:00.000Z" };
    expect(normalizeCallParticipantUpdate(current, { lease_refreshed_at: "2999-01-01" }, "member-1", false, new Date("2026-09-04T00:04:30.000Z")))
      .toEqual({ lease_refreshed_at: "2026-09-04T00:04:30.000Z" });
    expect(normalizeCallParticipantUpdate(current, { left_at: "forged" }, "member-1", false, new Date("2026-09-04T00:05:00.000Z")))
      .toEqual({ left_at: "2026-09-04T00:05:00.000Z" });
    expect(() => normalizeCallParticipantUpdate({ ...current, left_at: "2026-09-04T00:05:00.000Z" }, { lease_refreshed_at: true }, "member-1"))
      .toThrow(/no longer active/i);
    expect(() => normalizeCallParticipantUpdate({ ...current, lease_refreshed_at: "2026-09-04T00:01:00.000Z" }, { lease_refreshed_at: true }, "member-1", false, new Date("2026-09-04T00:05:00.000Z")))
      .toThrow(/lease expired/i);
    expect(() => normalizeCallParticipantUpdate(current, { session_id: "another" }, "member-1")).toThrow(/heartbeat or leaving/i);
    expect(() => normalizeCallParticipantUpdate(current, { left_at: true }, "attacker")).toThrow(/own call/i);
  });

  it("derives final call state and rejects finalization while anyone is active", () => {
    const session = { id: "session-1", room_id: "room-1", started_by: "member-1", started_at: "2026-09-04T00:00:00.000Z", ended_at: null };
    const participants = [
      { user_id: "member-1", left_at: "2026-09-04T00:03:00.000Z" },
      { user_id: "member-2", left_at: "2026-09-04T00:04:00.000Z" },
    ];
    expect(normalizeCallSessionFinalization(session, {
      ended_at: "forged", duration_seconds: 99999, participant_count: 999,
    }, participants, "member-1", false, new Date("2026-09-04T00:05:00.000Z"))).toEqual({
      ended_at: "2026-09-04T00:05:00.000Z", duration_seconds: 300, participant_count: 2, failure_reason: null,
    });
    expect(() => normalizeCallSessionFinalization(session, { ended_at: true }, [
      { user_id: "member-1", left_at: null, lease_refreshed_at: "2026-09-04T00:04:30.000Z" },
    ], "member-1", false, new Date("2026-09-04T00:05:00.000Z"))).toThrow(/still active/i);
    expect(() => normalizeCallSessionFinalization(session, { ended_at: true }, [
      { user_id: "member-1", left_at: null, lease_refreshed_at: "2026-09-04T00:02:00.000Z" },
    ], "member-1", false, new Date("2026-09-04T00:05:00.000Z"))).not.toThrow();
    expect(() => normalizeCallSessionFinalization(session, { ended_at: true }, participants, "outsider"))
      .toThrow(/caller or a participant/i);
  });
});

describe("forum deletion policy", () => {
  it("blocks member hard-delete while retaining moderator removal", () => {
    expect(() => assertCoreDeleteAllowed("posts", memberContext)).toThrow(/delete-for-everyone/i);
    expect(() => assertCoreDeleteAllowed("posts", { ...memberContext, auth: { ...memberContext.auth, role: "admin" } })).not.toThrow();
    expect(() => assertCoreDeleteAllowed("comments", memberContext)).not.toThrow();
  });
});

describe("forum post references", () => {
  const source = { scope_type: "COHORT", scope_key: "IIT_DELHI|MBA|GENERAL|2026" };

  it("keeps replies and reshares inside the same top-level forum scope", () => {
    expect(() => assertPostReferenceScope(source, { ...source, reply_to_id: null }, "reply")).not.toThrow();
    expect(() => assertPostReferenceScope(source, { scope_type: "GLOBAL", scope_key: "IIT_ALL", reply_to_id: null }, "reply"))
      .toThrow(/same forum scope/i);
    expect(() => assertPostReferenceScope(source, { ...source, reply_to_id: "nested-parent" }, "reply"))
      .toThrow(/top-level/i);
    expect(() => assertPostReferenceScope(source, { scope_type: "CAMPUS", scope_key: "IIT_DELHI", reply_to_id: null }, "reshare"))
      .toThrow(/same forum scope/i);
  });
});

describe("comment thread depth", () => {
  it("allows one reply level and rejects nested or cross-post parents", () => {
    expect(() => assertCommentParent("post-one", { post_id: "post-one", parent_comment_id: null })).not.toThrow();
    expect(() => assertCommentParent("post-one", { post_id: "post-one", parent_comment_id: "root" })).toThrow(/top-level/i);
    expect(() => assertCommentParent("post-one", { post_id: "post-two", parent_comment_id: null })).toThrow(/same post/i);
  });

  it("redacts a deleted author without removing another member's reply", () => {
    expect(commentTombstonePatch(new Date("2026-09-04T00:00:00.000Z"))).toEqual({
      content: "", author_id: null, edited_at: new Date("2026-09-04T00:00:00.000Z"),
    });
  });
});

describe("poll ballot privacy", () => {
  it("exposes the viewer's ballot while anonymizing every other ballot", () => {
    const ballot = { id: "vote-one", poll_id: "poll-one", user_id: "member-one", option_index: 1 };
    expect(publicLegacyRow("poll_votes", ballot, "member-one")).toEqual(ballot);
    expect(publicLegacyRow("poll_votes", ballot, "member-two")).toEqual({ poll_id: "poll-one", option_index: 1 });
  });
});

describe("blog comment creation shape", () => {
  it("replaces client-authored identity, visibility, IDs, and timestamps", () => {
    expect(normalizeNewBlogCommentShape({
      blog_id: "blog-123", content: " Thoughtful reply ", author_id: "attacker",
      is_hidden: true, created_at: "invalid",
    }, "member-1", new Date("2026-09-04T00:00:00.000Z"))).toMatchObject({
      blog_id: "blog-123", content: "Thoughtful reply", author_id: "member-1",
      is_hidden: false, parent_id: null, created_at: "2026-09-04T00:00:00.000Z",
    });
  });

  it("rejects malformed or oversized public comment content", () => {
    expect(() => normalizeNewBlogCommentShape({ blog_id: "blog-123", content: {} }, "member-1")).toThrow(/text is required/i);
    expect(() => normalizeNewBlogCommentShape({ blog_id: "blog-123", content: "x".repeat(5_001) }, "member-1")).toThrow(/too long/i);
    expect(() => normalizeNewBlogCommentShape({ blog_id: "", content: "hello" }, "member-1")).toThrow(/valid article/i);
  });
});

describe("blog likes and bookmarks", () => {
  it("derives identity and timestamps instead of trusting public counters", () => {
    expect(normalizeBlogAffinityShape("blog_likes", {
      blog_id: " blog-one ", user_id: "attacker", id: "forged", created_at: "forged",
    }, "member-one", new Date("2026-09-04T00:00:00.000Z"))).toEqual({
      id: expect.any(String), blog_id: "blog-one", user_id: "member-one", created_at: "2026-09-04T00:00:00.000Z",
    });
    expect(() => normalizeBlogAffinityShape("blog_bookmarks", { blog_id: {} }, "member-one")).toThrow(/valid article/i);
  });
});
