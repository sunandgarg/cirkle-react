import { describe, expect, it } from "vitest";
import { uniqueIdentifiers } from "@/lib/identifiers";

describe("uniqueIdentifiers", () => {
  it("preserves valid IDs while removing anonymous and malformed identities", () => {
    expect(uniqueIdentifiers([null, " user-1 ", undefined, "", "user-2", "user-1", 42, {}]))
      .toEqual(["user-1", "user-2"]);
  });

  it("returns an empty list for an entirely anonymous timeline", () => {
    expect(uniqueIdentifiers([null, undefined, "  "])).toEqual([]);
  });
});
