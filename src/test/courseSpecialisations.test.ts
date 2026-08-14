import { describe, expect, it } from "vitest";
import { ALL_COURSES, getSpecialisations } from "@/data/courseSpecialisations";

describe("program selection", () => {
  it("contains the complete ordered program list with Other last", () => {
    expect(ALL_COURSES).toEqual([
      "BTech", "MTech", "PhD", "MSc", "MBA", "Dual Degree", "BS", "MS", "MA", "BDes",
      "MDes", "BArch", "MArch", "MS by Research", "MPP", "Executive MBA", "Integrated Degree",
      "MCP", "MHRM", "LLB", "LLM", "MMST", "MEngg", "MDP", "BSc-BEd", "B.Cyber",
      "MDes by Research", "MA by Research", "Other",
    ]);
  });

  it("provides a safe General specialisation for standardized programs", () => {
    expect(getSpecialisations("MArch")).toEqual(["General"]);
    expect(getSpecialisations("Other")).toEqual([]);
  });
});
