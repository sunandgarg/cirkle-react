import { beforeEach, describe, expect, it } from "vitest";
import { purgeLegacyRecentSearches, readRecentSearches, saveRecentSearch } from "@/lib/recentSearches";

describe("recent searches", () => {
  beforeEach(() => localStorage.clear());

  it("keeps search history private to each signed-in user", () => {
    saveRecentSearch("viewer-a", "product leaders");
    saveRecentSearch("viewer-b", "climate founders");

    expect(readRecentSearches("viewer-a")).toEqual(["product leaders"]);
    expect(readRecentSearches("viewer-b")).toEqual(["climate founders"]);
    expect(readRecentSearches(null)).toEqual([]);
  });

  it("deduplicates, caps, and removes the unsafe legacy global key", () => {
    localStorage.setItem("recent_searches", JSON.stringify(["another account's query"]));
    for (let index = 0; index < 12; index += 1) saveRecentSearch("viewer-a", `query ${index}`);
    saveRecentSearch("viewer-a", "query 8");
    purgeLegacyRecentSearches();

    expect(localStorage.getItem("recent_searches")).toBeNull();
    expect(readRecentSearches("viewer-a")).toHaveLength(10);
    expect(readRecentSearches("viewer-a")[0]).toBe("query 8");
  });
});
