import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { hashOtp, keyedHash } from "../src/security/crypto.js";
import { invokeFunction, resolveVerificationDecision, verifyInstitute } from "../src/services/functions.js";
import { buildVerifiedAffiliation, callRpc, customOptionCategories } from "../src/services/rpc.js";
import type { RequestContext } from "../src/types.js";

afterEach(() => vi.restoreAllMocks());

describe("document verification invariants", () => {
  it("derives the email decision from the reviewed submission", () => {
    expect(resolveVerificationDecision({ submission_id: "submission-one" }, {
      id: "submission-one", status: "approved", review_notes: "Verified manually",
    })).toEqual({ decision: "approved", reason: "Verified manually" });
  });

  it("rejects an email decision that conflicts with stored review state", () => {
    expect(() => resolveVerificationDecision({ decision: "rejected" }, { status: "approved" }))
      .toThrow(/does not match/);
    expect(() => resolveVerificationDecision({}, { status: "pending" })).toThrow(/has not been reviewed/);
  });

  it("creates a canonical provisional affiliation and enriches it during onboarding", () => {
    const provisional = buildVerifiedAffiliation(undefined, {
      userId: "member-one", iitName: "IIT Delhi", studentStatus: "current_student",
      source: "document", sourceSubmissionId: "submission-one",
    });
    expect(provisional).toMatchObject({
      user_id: "member-one", network_id: "IIT", institute_id: "IIT_DELHI", institute_name: "IIT Delhi",
      member_status: "current_student", verification_status: "VERIFIED", verification_source: "document",
      source_submission_id: "submission-one",
    });

    const complete = buildVerifiedAffiliation(provisional, {
      userId: "member-one", iitName: "IIT Delhi", studentStatus: "current_student", source: "document",
      education: { id: "education-one", degree: "BTech", specialisation: "Computer Science", passingYear: "2028" },
    });
    expect(complete).toMatchObject({
      source_submission_id: "submission-one", degree_id: "BTECH", specialisation_id: "COMPUTER_SCIENCE",
      graduation_year: 2028, source_education_id: "education-one",
    });
  });

  it("accepts degree as a moderated custom-option category", () => {
    expect(customOptionCategories.has("degree")).toBe(true);
    expect(customOptionCategories.has("role")).toBe(false);
  });
});

describe("institute OTP concurrency", () => {
  it("does not verify a profile when another correct request consumed the challenge first", async () => {
    const email = "student@iitd.ac.in";
    vi.spyOn(prisma.emailOtp, "findFirst").mockResolvedValue({
      id: "iit-otp", user_id: "member-one", email, destination_hash: keyedHash(email),
      code_hash: await hashOtp("123456"), purpose: "institute", attempts: 0, max_attempts: 5,
      expires_at: new Date(Date.now() + 60_000), consumed_at: null, ip_hash: null, created_at: new Date(),
    });
    vi.spyOn(prisma.emailOtp, "updateMany").mockResolvedValue({ count: 1 });
    const updateProfile = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ user_id: "member-one" }]),
      emailOtp: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      profile: { findUnique: vi.fn().mockResolvedValue({ verification_revoked_at: null }), upsert: updateProfile },
      legacyRecord: { upsert: vi.fn() },
    }));
    const ctx: RequestContext = {
      auth: { id: "member-one", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: false },
    };

    await expect(verifyInstitute({
      email, iit_name: "IIT Delhi", student_status: "current_student", code: "123456",
    }, ctx)).rejects.toMatchObject({ code: "invalid_otp" });
    expect(updateProfile).not.toHaveBeenCalled();
  }, 15_000);

  it("cannot consume an institute OTP after an administrator revoked verification", async () => {
    const email = "student@iitd.ac.in";
    vi.spyOn(prisma.emailOtp, "findFirst").mockResolvedValue({
      id: "iit-otp", user_id: "member-one", email, destination_hash: keyedHash(email),
      code_hash: await hashOtp("123456"), purpose: "institute", attempts: 0, max_attempts: 5,
      expires_at: new Date(Date.now() + 60_000), consumed_at: null, ip_hash: null, created_at: new Date(),
    });
    vi.spyOn(prisma.emailOtp, "updateMany").mockResolvedValue({ count: 1 });
    const claim = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ user_id: "member-one" }]),
      profile: { findUnique: vi.fn().mockResolvedValue({ verification_revoked_at: new Date() }) },
      emailOtp: { updateMany: claim },
    }));
    const ctx: RequestContext = {
      auth: { id: "member-one", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: false },
    };

    await expect(verifyInstitute({
      email, iit_name: "IIT Delhi", student_status: "current_student", code: "123456",
    }, ctx)).rejects.toMatchObject({ code: "verification_revoked" });
    expect(claim).not.toHaveBeenCalled();
  }, 15_000);
});

describe("verified onboarding replay protection", () => {
  it("locks the profile and rejects a second academic onboarding attempt", async () => {
    const legacyWrite = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      $queryRaw: vi.fn().mockResolvedValue([{ user_id: "member-one" }]),
      profile: { findUnique: vi.fn().mockResolvedValue({
        user_id: "member-one", name: "Member", iit_name: "IIT Delhi", student_status: "current_student",
        is_verified: true, verification_revoked_at: null, onboarding_completed: true,
      }) },
      legacyRecord: { findMany: legacyWrite },
    }));
    const ctx: RequestContext = {
      auth: { id: "member-one", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: true },
    };

    await expect(callRpc("complete_member_onboarding", {
      p_name: "Member", p_iit_name: "IIT Delhi", p_degree: "MBA", p_specialisation: "General",
      p_passing_year: "2026", p_phone: "9876543210", p_phone_country_code: "+91",
    }, ctx)).rejects.toMatchObject({ code: "onboarding_already_completed" });
    expect(legacyWrite).not.toHaveBeenCalled();
  });
});

describe("verified feature gates", () => {
  it("does not let an unverified account consume KLIPY quota", async () => {
    const ctx: RequestContext = {
      auth: { id: "unverified", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: false },
    };
    await expect(invokeFunction("klipy-search", { q: "hello" }, ctx, {}))
      .rejects.toMatchObject({ code: "verification_required", status: 403 });
  });
});
