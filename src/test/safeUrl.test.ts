import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "@/lib/safeUrl";

describe("safeHttpUrl", () => {
  it("allows normal http and https links", () => {
    expect(safeHttpUrl("https://jobs.example.com/opening?id=1")).toBe("https://jobs.example.com/opening?id=1");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
  });

  it("rejects script, credentialed, relative, and malformed links", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("https://user:pass@example.com/private")).toBeNull();
    expect(safeHttpUrl("/relative")).toBeNull();
    expect(safeHttpUrl("not a URL")).toBeNull();
  });
});
