import { beforeEach, describe, expect, it } from "vitest";
import { readRecoveryToken } from "@/pages/ResetPassword";

describe("password-reset token handling", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/reset-password");
  });

  it("retains the token in this tab without consuming it on page load", () => {
    const token = "r".repeat(48);
    window.history.replaceState({}, "", `/reset-password?token=${token}&source=email#form`);

    expect(readRecoveryToken()).toBe(token);
    expect(window.location.search).toBe("?source=email");
    expect(window.location.hash).toBe("#form");
    expect(readRecoveryToken()).toBe(token);
  });

  it("rejects malformed reset tokens", () => {
    window.history.replaceState({}, "", "/reset-password?token=short");

    expect(readRecoveryToken()).toBe("");
    expect(window.location.search).toBe("");
  });
});
