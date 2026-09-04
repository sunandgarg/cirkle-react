import { describe, expect, it } from "vitest";
import { instituteDomains } from "../src/services/functions.js";

describe("IIT verification domains", () => {
  it("covers all 23 IITs exposed by onboarding", () => {
    expect(Object.keys(instituteDomains)).toHaveLength(23);
    expect(instituteDomains["IIT Dhanbad (ISM)"]).toEqual(["iitism.ac.in", "alumni.iitism.ac.in"]);
    expect(instituteDomains["IIT BHU"]).toEqual(["iitbhu.ac.in", "alumni.iitbhu.ac.in"]);
  });
});
