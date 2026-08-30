import { describe, expect, it } from "vitest";
import {
  documentDecisionEmail,
  iitVerificationEmail,
  loginCodeEmail,
} from "../../supabase/functions/_shared/emailTemplate";

describe("Cirkle email templates", () => {
  it("renders a clear one-time login code without weakening the security copy", () => {
    const message = loginCodeEmail("482913");

    expect(message.subject).toContain("482913");
    expect(message.html).toContain("482913");
    expect(message.html).toContain("expires in 10 minutes");
    expect(message.html).toContain("Never share this code");
    expect(message.text).toContain("Cirkle.World");
  });

  it("escapes institute and admin-provided content", () => {
    const iitMessage = iitVerificationEmail("123456", '<img src=x onerror="alert(1)">');
    const decisionMessage = documentDecisionEmail({
      approved: false,
      iitName: "IIT Delhi",
      note: "<script>alert('x')</script>",
    });

    expect(iitMessage.html).not.toContain("<img src=x");
    expect(iitMessage.html).toContain("&lt;img");
    expect(decisionMessage.html).not.toContain("<script>");
    expect(decisionMessage.html).toContain("&lt;script&gt;");
  });
});
