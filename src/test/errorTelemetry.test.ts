import { describe, expect, it } from "vitest";
import { buildClientErrorEvent } from "@/lib/errorTelemetry";

describe("structured error telemetry", () => {
  it("adds flow context and redacts sensitive metadata", () => {
    const event = buildClientErrorEvent(Object.assign(new Error("Profile save failed"), { code: "23503" }), {
      flow: "member_onboarding",
      action: "save_account_details",
      metadata: { step: "account_details", accessToken: "do-not-log", email: "member@example.com" },
    });
    expect(event.flow).toBe("member_onboarding");
    expect(event.action).toBe("save_account_details");
    expect(event.code).toBe("23503");
    expect(event.metadata.accessToken).toBe("[redacted]");
    expect(event.metadata.step).toBe("account_details");
  });
});
