import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMobileTestDocumentSubmission,
  clearMobileTestSession,
  readMobileTestSession,
  saveMobileTestDocumentSubmission,
  startMobileTestSession,
  withdrawMobileTestDocumentSubmission,
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

  it("does not restore a request after it is withdrawn", () => {
    startMobileTestSession("+91", "9999999999");
    saveMobileTestDocumentSubmission("IIT Delhi", "alumni");
    expect(withdrawMobileTestDocumentSubmission()).toBe(true);

    clearMobileTestSession();
    startMobileTestSession("+91", "9999999999");

    expect(readMobileTestSession()?.documentVerificationStatus).toBeUndefined();
    clearMobileTestDocumentSubmission();
  });
});
