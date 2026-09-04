import { describe, expect, it } from "vitest";
import { resolveVerificationDecision } from "../src/services/functions.js";
import { buildVerifiedAffiliation, customOptionCategories } from "../src/services/rpc.js";

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
