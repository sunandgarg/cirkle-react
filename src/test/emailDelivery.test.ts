import { describe, expect, it } from "vitest";
import { resolveEmailProviderOrder } from "../../supabase/functions/_shared/emailDelivery";

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
});
