import { describe, expect, it } from "vitest";
import { IIT_LIST, expectedIitEmailDomain, isMatchingIitEmail } from "@/data/iitInstitutes";

const iitBombay = IIT_LIST.find((iit) => iit.name === "IIT Bombay")!;

describe("IIT email validation", () => {
  it("accepts only the selected IIT student domain for current students", () => {
    expect(isMatchingIitEmail("student@iitb.ac.in", iitBombay, "current_student")).toBe(true);
    expect(isMatchingIitEmail("student@iitd.ac.in", iitBombay, "current_student")).toBe(false);
    expect(isMatchingIitEmail("student@college.ac.in", iitBombay, "current_student")).toBe(false);
    expect(isMatchingIitEmail("student@alumni.iitb.ac.in", iitBombay, "current_student")).toBe(false);
  });

  it("accepts only the selected IIT alumni domain for alumni", () => {
    expect(isMatchingIitEmail("graduate@alumni.iitb.ac.in", iitBombay, "alumni")).toBe(true);
    expect(isMatchingIitEmail("graduate@iitb.ac.in", iitBombay, "alumni")).toBe(false);
    expect(expectedIitEmailDomain(iitBombay, "alumni")).toBe("alumni.iitb.ac.in");
  });

  it("normalizes case and whitespace but rejects malformed addresses", () => {
    expect(isMatchingIitEmail("  Student@IITB.AC.IN  ", iitBombay, "current_student")).toBe(true);
    expect(isMatchingIitEmail("student@@iitb.ac.in", iitBombay, "current_student")).toBe(false);
    expect(isMatchingIitEmail("@iitb.ac.in", iitBombay, "current_student")).toBe(false);
  });
});
