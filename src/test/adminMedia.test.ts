import { describe, expect, it } from "vitest";
import { versionedInstituteLogoPath } from "@/lib/adminMedia";

describe("admin institute-logo storage", () => {
  it("uses a new immutable object key for each replacement", () => {
    const first = versionedInstituteLogoPath("iitd.ac.in", "version-one");
    const second = versionedInstituteLogoPath("iitd.ac.in", "version-two");
    expect(first).toBe("iitd-ac-in-version-one.webp");
    expect(second).toBe("iitd-ac-in-version-two.webp");
    expect(second).not.toBe(first);
  });
});
