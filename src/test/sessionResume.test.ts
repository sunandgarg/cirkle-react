import { beforeEach, describe, expect, it } from "vitest";
import { readResumeRoute, readSafeReturnRoute, resolvePostAuthRoute, saveResumeRoute } from "@/lib/sessionResume";

describe("durable member route resume", () => {
  beforeEach(() => localStorage.clear());

  it("restores the last safe forum room after login", () => {
    saveResumeRoute("member-1", "/cirkle-forum?room=cohort");
    expect(readResumeRoute("member-1")).toBe("/cirkle-forum?room=cohort");
  });

  it("does not persist authentication, verification, or admin routes", () => {
    saveResumeRoute("member-1", "/iit-verify");
    saveResumeRoute("member-1", "/auth");
    saveResumeRoute("member-1", "/admin");
    expect(readResumeRoute("member-1")).toBe("/cirkle-forum");
  });

  it("isolates resume state per member", () => {
    saveResumeRoute("member-1", "/profile");
    expect(readResumeRoute("member-1")).toBe("/profile");
    expect(readResumeRoute("member-2")).toBe("/cirkle-forum");
  });

  it("always opens the admin panel for an authenticated admin", () => {
    saveResumeRoute("admin-1", "/cirkle-forum?room=cohort");
    expect(resolvePostAuthRoute("admin-1", true)).toBe("/admin");
    expect(resolvePostAuthRoute("member-1", false)).toBe("/cirkle-forum");
  });

  it("returns a member to the protected route that sent them to login", () => {
    expect(resolvePostAuthRoute("member-1", false, "/u/member-slug?tab=about")).toBe("/u/member-slug?tab=about");
    expect(resolvePostAuthRoute("admin-1", true, "/profile/member-2")).toBe("/profile/member-2");
  });

  it("rejects external and authentication return locations", () => {
    expect(readSafeReturnRoute("https://attacker.example/profile")).toBeNull();
    expect(readSafeReturnRoute("//attacker.example/profile")).toBeNull();
    expect(readSafeReturnRoute("/\\attacker.example/profile")).toBeNull();
    expect(readSafeReturnRoute("/auth?returnTo=/profile")).toBeNull();
    expect(resolvePostAuthRoute("member-1", false, "//attacker.example")).toBe("/cirkle-forum");
  });
});
