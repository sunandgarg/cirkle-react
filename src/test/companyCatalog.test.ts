import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { topCompanies } from "@/data/topCompanies";
import { findCompanyOption, getCompanyLogo, getCompanyLogoAsync, isKnownCompany, shouldOfferInitialCompanyLogo } from "@/lib/companyCatalog";

const options = [
  { id: "custom-1", category: "company", value: "DekhoCampus", status: "pending", created_by: "member-1", logo_url: "https://example.com/logo.webp" },
];

describe("company catalog logo rules", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => topCompanies,
    })));
  });

  afterAll(() => vi.unstubAllGlobals());

  it("recognizes built-in and previously submitted companies without case sensitivity", () => {
    expect(isKnownCompany("  acme  ", ["Acme"], options)).toBe(true);
    expect(findCompanyOption("dekhocampus", options)?.id).toBe("custom-1");
  });

  it("offers a logo only for a first-time custom company submission", () => {
    expect(shouldOfferInitialCompanyLogo("New Venture", false, ["Acme"], options)).toBe(true);
    expect(shouldOfferInitialCompanyLogo("DekhoCampus", false, ["Acme"], options)).toBe(false);
    expect(shouldOfferInitialCompanyLogo("New Venture", true, ["Acme"], options)).toBe(false);
  });

  it("ships 11,000 ranked and three Cirkle companies with WebP-only lazy-loadable logos", async () => {
    expect(topCompanies).toHaveLength(11003);
    expect(topCompanies.slice(0, 11000).every((company, index) => company.rank === index + 1)).toBe(true);
    expect(topCompanies.every((company) => company.logo.endsWith(".webp"))).toBe(true);
    expect(await getCompanyLogoAsync("Apple")).toMatch(/\.webp$/);
    expect(getCompanyLogo("Google")).toBe(getCompanyLogo("Alphabet (Google)"));
    expect(getCompanyLogo("Louis Stitch")).toMatch(/11001-louis-stitch\.webp$/);
    expect(getCompanyLogo("DekhoCampus")).toMatch(/11002-dekhocampus\.webp$/);
    expect(getCompanyLogo("Cirkle")).toMatch(/11003-cirkle\.webp$/);
  });
});
