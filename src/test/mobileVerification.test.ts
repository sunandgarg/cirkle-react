import { beforeEach, describe, expect, it } from "vitest";
import {
  hasMobileTestMode,
  isEmailTestMode,
  readMobileTestSession,
  startMobileTestSession,
} from "@/lib/mobileVerification";

describe("production authentication safeguards", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("ships with the local phone sandbox disabled", () => {
    expect(hasMobileTestMode()).toBe(false);
    expect(startMobileTestSession("+91", "9999999999")).toBe(false);
    expect(readMobileTestSession()).toBeNull();
  });

  it("cannot be activated by injecting browser storage", () => {
    localStorage.setItem("cirkle:mobile-test-session", JSON.stringify({
      phone: "9999999999",
      countryCode: "+91",
      isVerified: true,
      onboardingCompleted: true,
    }));
    expect(readMobileTestSession()).toBeNull();
    expect(isEmailTestMode()).toBe(false);
  });
});
