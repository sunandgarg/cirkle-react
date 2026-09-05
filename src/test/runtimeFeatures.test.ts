import { describe, expect, it } from "vitest";
import { resolveDailyCallAvailability, resolveDailyCallsEnabled } from "@/hooks/useRuntimeFeatures";

describe("Daily call feature gate", () => {
  it("requires both the reviewed Pages flag and the server capability", () => {
    expect(resolveDailyCallsEnabled(false, { daily_calls: true })).toBe(false);
    expect(resolveDailyCallsEnabled(true, { daily_calls: false })).toBe(false);
    expect(resolveDailyCallsEnabled(true, { daily_calls: true })).toBe(true);
  });

  it("fails closed for unavailable or malformed capability responses", () => {
    expect(resolveDailyCallsEnabled(true, undefined)).toBe(false);
    expect(resolveDailyCallsEnabled(true, null)).toBe(false);
    expect(resolveDailyCallsEnabled(true, { daily_calls: "true" })).toBe(false);
  });

  it("does not reject a valid incoming link while capability discovery is pending", () => {
    expect(resolveDailyCallAvailability(true, undefined, true)).toEqual({ enabled: false, resolved: false });
    expect(resolveDailyCallAvailability(true, { daily_calls: true }, false)).toEqual({ enabled: true, resolved: true });
    expect(resolveDailyCallAvailability(true, undefined, false)).toEqual({ enabled: false, resolved: true });
    expect(resolveDailyCallAvailability(false, undefined, true)).toEqual({ enabled: false, resolved: true });
  });
});
