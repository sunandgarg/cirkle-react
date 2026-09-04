import { describe, expect, it } from "vitest";
import { effectiveMemberStatus, shouldBeAlumni } from "@/lib/memberStatus";

describe("automatic alumni transition", () => {
  it("keeps the member current until India midnight on 1 July", () => {
    expect(shouldBeAlumni("2026", new Date("2026-06-30T18:29:59.999Z"))).toBe(false);
  });

  it("promotes the member exactly from India midnight on 1 July", () => {
    const julyFirst = new Date("2026-06-30T18:30:00.000Z");
    expect(shouldBeAlumni("2026", julyFirst)).toBe(true);
    expect(effectiveMemberStatus("current_student", "2026", julyFirst)).toBe("alumni");
    expect(effectiveMemberStatus("alumni", "2026", julyFirst)).toBe("alumni");
  });
});
