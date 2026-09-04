import { describe, expect, it } from "vitest";
import {
  alumniAffiliationData,
  alumniCutoffYear,
  millisecondsUntilNextIstMidnight,
  shouldTransitionToAlumni,
} from "../src/services/memberStatus.js";

describe("automatic member-status reconciliation", () => {
  it("switches the cutoff exactly at July 1 midnight in India", () => {
    const before = new Date("2026-06-30T18:29:59.999Z");
    const boundary = new Date("2026-06-30T18:30:00.000Z");
    expect(alumniCutoffYear(before)).toBe(2025);
    expect(alumniCutoffYear(boundary)).toBe(2026);
    expect(shouldTransitionToAlumni("2026", before)).toBe(false);
    expect(shouldTransitionToAlumni(2026, boundary)).toBe(true);
  });

  it("rejects missing or implausible passing years", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(shouldTransitionToAlumni(null, now)).toBe(false);
    expect(shouldTransitionToAlumni("not-a-year", now)).toBe(false);
    expect(shouldTransitionToAlumni(1949, now)).toBe(false);
    expect(shouldTransitionToAlumni(2027, now)).toBe(false);
  });

  it("schedules the next run at the next India midnight", () => {
    expect(millisecondsUntilNextIstMidnight(new Date("2026-09-04T18:29:00.000Z"))).toBe(60_000);
    expect(millisecondsUntilNextIstMidnight(new Date("2026-09-04T18:30:00.000Z"))).toBe(24 * 60 * 60_000);
  });

  it("keeps both canonical affiliation status fields in sync", () => {
    const updatedAt = new Date("2026-07-01T00:00:00.000Z");
    expect(alumniAffiliationData({ id: "affiliation-1", student_status: "current_student", member_status: "current_student" }, updatedAt)).toMatchObject({
      id: "affiliation-1",
      student_status: "alumni",
      member_status: "alumni",
      updated_at: updatedAt.toISOString(),
    });
  });
});
