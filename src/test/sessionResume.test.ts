import { beforeEach, describe, expect, it } from "vitest";
import { readResumeRoute, resolvePostAuthRoute, saveResumeRoute } from "@/lib/sessionResume";

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
});
