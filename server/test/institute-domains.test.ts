import { describe, expect, it } from "vitest";
import { instituteDomains } from "../src/services/functions.js";
import { isIitEmailAddress } from "../src/services/iitDomains.js";

describe("IIT verification domains", () => {
  it("covers all 23 IITs exposed by onboarding", () => {
    expect(Object.keys(instituteDomains)).toHaveLength(23);
    expect(instituteDomains["IIT Dhanbad (ISM)"]).toEqual(["iitism.ac.in", "alumni.iitism.ac.in"]);
    expect(instituteDomains["IIT BHU"]).toEqual(["iitbhu.ac.in", "alumni.iitbhu.ac.in"]);
  });

  it("routes only exact supported student and alumni domains", () => {
    for (const [student, alumni] of Object.values(instituteDomains)) {
      expect(isIitEmailAddress(`member@${student}`)).toBe(true);
      expect(isIitEmailAddress(`member@${alumni}`)).toBe(true);
    }
    expect(isIitEmailAddress("member@iitd.ac.in.attacker.example")).toBe(false);
    expect(isIitEmailAddress("member@subdomain.iitd.ac.in")).toBe(false);
    expect(isIitEmailAddress("not-an-email")).toBe(false);
  });
});
