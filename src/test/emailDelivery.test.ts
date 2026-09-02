import { describe, expect, it } from "vitest";
import { isInstituteEmailAddress, resolveEmailProviderOrder } from "../../supabase/functions/_shared/emailDelivery";

describe("transactional email provider routing", () => {
  it("supports Brevo as a primary provider with deterministic fallbacks", () => {
    expect(resolveEmailProviderOrder("brevo", "zeptomail,zavu,ses")).toEqual([
      "brevo",
      "zeptomail",
      "zavu",
      "ses",
    ]);
  });

  it("normalizes legacy Zoho naming without duplicating providers", () => {
    expect(resolveEmailProviderOrder("zoho", "brevo,zeptomail,zavu,ses")).toEqual([
      "zeptomail",
      "brevo",
      "zavu",
      "ses",
    ]);
  });

  it("routes only exact supported IIT domains as institute addresses", () => {
    expect(isInstituteEmailAddress("sme246733@iitd.ac.in")).toBe(true);
    expect(isInstituteEmailAddress("member@alumni.iitb.ac.in")).toBe(true);
    expect(isInstituteEmailAddress("member@gmail.com")).toBe(false);
    expect(isInstituteEmailAddress("member@fake-iitd.ac.in.example.com")).toBe(false);
  });
});
