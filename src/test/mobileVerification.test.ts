import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMobileTestDocumentSubmission,
  clearMobileTestSession,
  hasMobileTestAcademicProfile,
  readMobileTestSession,
  saveMobileTestCourseRequest,
  saveMobileTestDocumentSubmission,
  startMobileTestSession,
  updateMobileTestSession,
  withdrawMobileTestDocumentSubmission,
  withdrawMobileTestCourseRequest,
} from "@/lib/mobileVerification";

describe("mobile test document verification lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores a pending request after returning to login", () => {
    expect(startMobileTestSession("+91", "9999999999")).toBe(true);
    expect(saveMobileTestDocumentSubmission("IIT Bombay", "current_student")).toBe(true);

    clearMobileTestSession();
    expect(startMobileTestSession("+91", "9999999999")).toBe(true);

    expect(readMobileTestSession()).toMatchObject({
      iitName: "IIT Bombay",
      studentStatus: "current_student",
      documentVerificationStatus: "pending",
    });
  });

  it("accepts the second configured test number", () => {
    expect(startMobileTestSession("+91", "8888888888")).toBe(true);
    expect(readMobileTestSession()).toMatchObject({ phone: "8888888888", countryCode: "+91" });
  });

  it("keeps onboarding fields used to build automatic forum groups", () => {
    startMobileTestSession("+91", "9999999999");
    expect(updateMobileTestSession({
      iitName: "IIT Delhi",
      degree: "MBA",
      specialisation: "General",
      passingYear: "2026",
    })).toBe(true);
    expect(readMobileTestSession()).toMatchObject({
      iitName: "IIT Delhi",
      degree: "MBA",
      specialisation: "General",
      passingYear: "2026",
    });
    expect(hasMobileTestAcademicProfile(readMobileTestSession())).toBe(true);
  });

  it("marks legacy test sessions without academic details as incomplete", () => {
    startMobileTestSession("+91", "9999999999");
    updateMobileTestSession({ onboardingCompleted: true, iitName: "IIT Delhi" });
    expect(hasMobileTestAcademicProfile(readMobileTestSession())).toBe(false);
  });

  it("does not restore a request after it is withdrawn", () => {
    startMobileTestSession("+91", "9999999999");
    saveMobileTestDocumentSubmission("IIT Delhi", "alumni");
    expect(withdrawMobileTestDocumentSubmission()).toBe(true);

    clearMobileTestSession();
    startMobileTestSession("+91", "9999999999");

    expect(readMobileTestSession()?.documentVerificationStatus).toBeUndefined();
    clearMobileTestDocumentSubmission();
  });

  it("holds a custom course request across test logins until it is changed", () => {
    startMobileTestSession("+91", "9999999999");
    expect(saveMobileTestCourseRequest("Master of Urban Systems")).toBe(true);
    clearMobileTestSession();
    startMobileTestSession("+91", "9999999999");
    expect(readMobileTestSession()).toMatchObject({
      customCourseName: "Master of Urban Systems",
      courseApprovalStatus: "pending",
    });

    expect(withdrawMobileTestCourseRequest()).toBe(true);
    clearMobileTestSession();
    startMobileTestSession("+91", "9999999999");
    expect(readMobileTestSession()?.courseApprovalStatus).toBeUndefined();
  });
});
