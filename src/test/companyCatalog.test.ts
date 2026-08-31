import { describe, expect, it } from "vitest";
import { findCompanyOption, isKnownCompany, shouldOfferInitialCompanyLogo } from "@/lib/companyCatalog";

const options = [
  { id: "custom-1", category: "company", value: "DekhoCampus", status: "pending", created_by: "member-1", logo_url: "https://example.com/logo.webp" },
];

describe("company catalog logo rules", () => {
  it("recognizes built-in and previously submitted companies without case sensitivity", () => {
    expect(isKnownCompany("  acme  ", ["Acme"], options)).toBe(true);
    expect(findCompanyOption("dekhocampus", options)?.id).toBe("custom-1");
  });

  it("offers a logo only for a first-time custom company submission", () => {
    expect(shouldOfferInitialCompanyLogo("New Venture", false, ["Acme"], options)).toBe(true);
    expect(shouldOfferInitialCompanyLogo("DekhoCampus", false, ["Acme"], options)).toBe(false);
    expect(shouldOfferInitialCompanyLogo("New Venture", true, ["Acme"], options)).toBe(false);
  });
});

