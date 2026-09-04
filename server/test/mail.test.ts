import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { ApiError } from "../src/lib/errors.js";
import { prisma } from "../src/lib/prisma.js";
import { issueEmailOtp, requestPasswordReset } from "../src/services/auth.js";
import { sendMail } from "../src/services/mail.js";
import {
  instituteVerificationEmail,
  loginCodeEmail,
  passwordResetEmail,
  verificationDecisionEmail,
} from "../src/services/mailTemplates.js";

const originalMailConfig = {
  NODE_ENV: config.NODE_ENV,
  ZEPTOMAIL_TOKEN: config.ZEPTOMAIL_TOKEN,
  ZEPTOMAIL_API_URL: config.ZEPTOMAIL_API_URL,
  ZEPTOMAIL_FROM_EMAIL: config.ZEPTOMAIL_FROM_EMAIL,
  ZEPTOMAIL_FROM_NAME: config.ZEPTOMAIL_FROM_NAME,
};

describe("active Cirkle email templates", () => {
  it("renders a responsive branded login code with a plain-text fallback", () => {
    const message = loginCodeEmail('482913<img src=x onerror="alert(1)">');

    expect(message.subject).toBe("Your Cirkle.World sign-in code");
    expect(message.subject).not.toContain("482913");
    expect(message.html).toContain("Cirkle.World");
    expect(message.html).toContain("The verified IIT network");
    expect(message.html).toContain('src="cid:cirkle-logo"');
    expect(message.html).toContain("@media only screen and (max-width: 620px)");
    expect(message.html).toContain("expires in 10 minutes");
    expect(message.html).toContain("Never share this code");
    expect(message.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(message.html).not.toContain('<img src=x onerror="alert(1)">');
    expect(message.text).toContain("482913");
  });

  it("renders the institute and document-decision variants with escaped content", () => {
    const institute = instituteVerificationEmail("123456");
    const decision = verificationDecisionEmail(false, "<script>alert('x')</script>");

    expect(institute.html).toContain("123456");
    expect(institute.text).toContain("used only once");
    expect(decision.html).not.toContain("<script>");
    expect(decision.html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(decision.text).toContain("Review note:");
  });

  it("renders only credential-free HTTP(S) password-reset links", () => {
    const message = passwordResetEmail("https://cirkle.world/reset-password?token=a&next=<unsafe>");

    expect(message.subject).toBe("Reset your Cirkle.World password");
    expect(message.html).toContain("Reset password");
    expect(message.html).toContain("&amp;next=%3Cunsafe%3E");
    expect(message.html).not.toContain("<unsafe>");
    expect(message.text).toContain("https://cirkle.world/reset-password");
    expect(() => passwordResetEmail("javascript:alert(1)")).toThrow("credential-free HTTP(S)");
    expect(() => passwordResetEmail("https://user:password@cirkle.world/reset-password")).toThrow("credential-free HTTP(S)");
  });
});

describe("active ZeptoMail REST delivery", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    config.NODE_ENV = "test";
    config.ZEPTOMAIL_TOKEN = "unit-test-send-key";
    config.ZEPTOMAIL_API_URL = "https://api.zeptomail.in/v1.1/email";
    config.ZEPTOMAIL_FROM_EMAIL = "noreply@cirkle.world";
    config.ZEPTOMAIL_FROM_NAME = "Cirkle";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    Object.assign(config, originalMailConfig);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("posts the active payload to the configured India endpoint with the real logo inline", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ request_id: "zepto-request-123" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));

    const receipt = await sendMail({
      to: "member@iitd.ac.in",
      ...loginCodeEmail("482913"),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.zeptomail.in/v1.1/email");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Zoho-enczapikey unit-test-send-key",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const payload = JSON.parse(String(init?.body));
    expect(payload.from).toEqual({ address: "noreply@cirkle.world", name: "Cirkle" });
    expect(payload.to).toEqual([{ email_address: { address: "member@iitd.ac.in" } }]);
    expect(payload.track_clicks).toBe(false);
    expect(payload.track_opens).toBe(false);
    expect(payload.client_reference).toMatch(/^cirkle-[0-9a-f-]{36}$/);
    expect(payload.htmlbody).toContain('src="cid:cirkle-logo"');
    expect(payload.inline_images).toEqual([
      expect.objectContaining({ cid: "cirkle-logo", mime_type: "image/png" }),
    ]);
    expect(payload.inline_images[0].content).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(receipt).toMatchObject({
      provider: "zeptomail",
      accepted: true,
      providerRequestId: "zepto-request-123",
    });
  });

  it("accepts a prefixed token without duplicating the authorization scheme", async () => {
    config.ZEPTOMAIL_TOKEN = "Zoho-enczapikey unit-test-send-key";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await sendMail({ to: "member@iitd.ac.in", ...loginCodeEmail("482913") });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ Authorization: "Zoho-enczapikey unit-test-send-key" });
  });

  it("fails closed in production when the send key is missing", async () => {
    config.NODE_ENV = "production";
    config.ZEPTOMAIL_TOKEN = undefined;

    await expect(sendMail({ to: "member@iitd.ac.in", ...loginCodeEmail("482913") }))
      .rejects.toMatchObject({ status: 503, code: "mail_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a sanitized provider rejection without reflecting the response body", async () => {
    fetchMock.mockResolvedValue(new Response("sensitive provider diagnostics", {
      status: 400,
      headers: { "x-request-id": "zepto-request-456" },
    }));

    let error: unknown;
    try {
      await sendMail({ to: "member@iitd.ac.in", ...loginCodeEmail("482913") });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 502,
      code: "mail_delivery_rejected",
      details: { upstream_status: 400, provider_request_id: "zepto-request-456" },
    });
    expect(String(error)).not.toContain("sensitive provider diagnostics");
  });

  it("distinguishes provider throttling, network failure, and timeout", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(sendMail({ to: "member@iitd.ac.in", ...loginCodeEmail("111111") }))
      .rejects.toMatchObject({ status: 503, code: "mail_provider_unavailable" });

    fetchMock.mockRejectedValueOnce(new TypeError("network unavailable"));
    await expect(sendMail({ to: "member@iitd.ac.in", ...loginCodeEmail("222222") }))
      .rejects.toMatchObject({ status: 502, code: "mail_delivery_failed" });

    const timeout = new Error("provider timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(sendMail({ to: "member@iitd.ac.in", ...loginCodeEmail("333333") }))
      .rejects.toMatchObject({ status: 504, code: "mail_delivery_timeout" });
  });

  it("consumes unusable challenges while retaining their delivery rate-limit history", async () => {
    fetchMock.mockRejectedValue(new TypeError("network unavailable"));
    vi.spyOn(prisma.emailOtp, "count").mockResolvedValue(0);
    vi.spyOn(prisma.user, "findUnique")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "member-one", email: "member@iitd.ac.in", status: "active" } as any);
    vi.spyOn(prisma.emailOtp, "create").mockResolvedValue({ id: "otp-one" } as any);
    const consumeOtp = vi.spyOn(prisma.emailOtp, "updateMany").mockResolvedValue({ count: 1 });
    vi.spyOn(prisma.passwordReset, "count").mockResolvedValue(0);
    vi.spyOn(prisma.passwordReset, "create").mockResolvedValue({ id: "reset-one" } as any);
    const consumeReset = vi.spyOn(prisma.passwordReset, "updateMany").mockResolvedValue({ count: 1 });

    await expect(issueEmailOtp("member@iitd.ac.in", "login", { ip: "127.0.0.1" }))
      .rejects.toMatchObject({ code: "mail_delivery_failed" });
    await expect(requestPasswordReset("member@iitd.ac.in"))
      .rejects.toMatchObject({ code: "mail_delivery_failed" });

    expect(consumeOtp).toHaveBeenCalledWith({ where: { id: "otp-one", consumed_at: null }, data: { consumed_at: expect.any(Date) } });
    expect(consumeReset).toHaveBeenCalledWith({ where: { id: "reset-one", used_at: null }, data: { used_at: expect.any(Date) } });
  }, 15_000);
});
