import { describe, expect, it } from "vitest";
import { resolveMemberAccessState } from "@/lib/memberAccess";

describe("cross-device member access", () => {
  it("does not mistake an unresolved profile on a new device for an unverified member", () => {
    expect(resolveMemberAccessState(null, false)).toBe("pending");
  });

  it("routes only a confirmed unverified server profile through verification", () => {
    expect(resolveMemberAccessState({ is_verified: false, onboarding_completed: false }, true)).toBe("verification");
  });

  it("restores a fully verified member directly to the app on every device", () => {
    expect(resolveMemberAccessState({ is_verified: true, onboarding_completed: true }, true)).toBe("ready");
  });

  it("resumes onboarding without repeating IIT verification", () => {
    expect(resolveMemberAccessState({ is_verified: true, onboarding_completed: false }, true)).toBe("onboarding");
  });
});
