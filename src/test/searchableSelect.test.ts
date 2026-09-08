import { describe, expect, it } from "vitest";
import { rankSearchableOptions, SEARCHABLE_SELECT_RESULT_LIMIT } from "@/components/SearchableSelect";

describe("large searchable selectors", () => {
  const companies = Array.from({ length: 12_000 }, (_, index) => `Company ${String(index).padStart(5, "0")}`);

  it("never mounts an unbounded company catalog", () => {
    const result = rankSearchableOptions(companies, "");
    expect(result.totalMatches).toBe(12_000);
    expect(result.options).toHaveLength(SEARCHABLE_SELECT_RESULT_LIMIT);
  });

  it("ranks prefix matches ahead of contains matches and reports hidden rows", () => {
    const result = rankSearchableOptions(["Beta Labs", "Alphabet", "Alpha Systems", "Zalpha"], "alpha", 3);
    expect(result.options).toEqual(["Alphabet", "Alpha Systems", "Zalpha"]);
    expect(result.totalMatches).toBe(3);
  });

  it("matches company names without case-sensitive surprises", () => {
    expect(rankSearchableOptions(["McKinsey & Company"], "mckinsey").options).toEqual(["McKinsey & Company"]);
  });
});
