import { describe, expect, it } from "vitest";
import { effectiveMemberStatus, shouldBeAlumni } from "@/lib/memberStatus";

describe("automatic alumni transition", () => {
  it("keeps the member current through 30 June of the graduation year", () => {
    expect(shouldBeAlumni("2026", new Date(2026, 5, 30, 23, 59, 59))).toBe(false);
  });

  it("promotes the member from 1 July of the graduation year", () => {
    const julyFirst = new Date(2026, 6, 1, 0, 0, 0);
    expect(shouldBeAlumni("2026", julyFirst)).toBe(true);
    expect(effectiveMemberStatus("current_student", "2026", julyFirst)).toBe("alumni");
    expect(effectiveMemberStatus("alumni", "2026", julyFirst)).toBe("alumni");
  });
});

