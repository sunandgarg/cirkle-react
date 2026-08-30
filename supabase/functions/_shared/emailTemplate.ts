const BRAND_BLUE = "#2563eb";
const INK = "#101828";
const MUTED = "#667085";
const SURFACE = "#f4f7fb";

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

type EmailTemplateInput = {
  eyebrow: string;
  title: string;
  intro: string;
  actionLabel?: string;
  actionUrl?: string;
  code?: string;
  codeLabel?: string;
  detail?: string;
  securityNote: string;
};

export const renderCirkleEmail = (input: EmailTemplateInput) => {
  const eyebrow = escapeHtml(input.eyebrow);
  const title = escapeHtml(input.title);
  const intro = escapeHtml(input.intro);
  const detail = input.detail ? escapeHtml(input.detail) : "";
  const securityNote = escapeHtml(input.securityNote);
  const actionUrl = input.actionUrl ? escapeHtml(input.actionUrl) : "";
  const actionLabel = input.actionLabel ? escapeHtml(input.actionLabel) : "";
  const code = input.code ? escapeHtml(input.code) : "";
  const codeLabel = escapeHtml(input.codeLabel || "Your secure code");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light">
    <title>${title}</title>
  </head>
  <body style="margin:0;background:${SURFACE};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:${INK};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${intro}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${SURFACE};padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e7ecf3;border-radius:24px;overflow:hidden;box-shadow:0 18px 48px rgba(16,24,40,.08);">
            <tr>
              <td style="height:6px;background:linear-gradient(90deg,#1d4ed8 0%,#4f8df7 55%,#8ab8ff 100%);"></td>
            </tr>
            <tr>
              <td style="padding:30px 32px 14px;">
                <table role="presentation" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding-right:12px;">
                      <img src="cid:cirkle-logo" width="42" height="42" alt="Cirkle.World" style="display:block;border-radius:12px;">
                    </td>
                    <td>
                      <div style="font-size:18px;font-weight:800;letter-spacing:-.02em;color:${INK};">Cirkle.World</div>
                      <div style="font-size:12px;color:${MUTED};margin-top:2px;">The verified IIT network</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 32px 32px;">
                <div style="font-size:12px;line-height:18px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${BRAND_BLUE};">${eyebrow}</div>
                <h1 style="margin:10px 0 12px;font-size:28px;line-height:36px;letter-spacing:-.03em;color:${INK};">${title}</h1>
                <p style="margin:0;font-size:16px;line-height:25px;color:${MUTED};">${intro}</p>
                ${code ? `<div style="margin:26px 0 22px;padding:20px 18px;text-align:center;background:#f7f9fc;border:1px solid #e4eaf2;border-radius:18px;"><div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">${codeLabel}</div><div style="margin-top:10px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:34px;line-height:42px;font-weight:800;letter-spacing:.22em;color:${INK};">${code}</div></div>` : ""}
                ${actionUrl && actionLabel ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0 22px;"><tr><td style="border-radius:12px;background:${BRAND_BLUE};"><a href="${actionUrl}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;line-height:20px;">${actionLabel}</a></td></tr></table>` : ""}
                ${detail ? `<p style="margin:0 0 20px;font-size:14px;line-height:22px;color:${MUTED};">${detail}</p>` : ""}
                <div style="padding:14px 16px;border-radius:14px;background:#eff6ff;border:1px solid #dbeafe;font-size:13px;line-height:20px;color:#344054;">🔒 ${securityNote}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #edf0f5;font-size:12px;line-height:19px;color:#98a2b3;">
                Sent by Cirkle.World · <a href="https://cirkle.world/privacy" style="color:#667085;">Privacy</a> · <a href="https://cirkle.world/terms" style="color:#667085;">Terms</a><br>
                This is an automated account-security message. Please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
};

export const loginCodeEmail = (code: string) => ({
  subject: `${code} is your Cirkle.World sign-in code`,
  text: `Your Cirkle.World sign-in code is ${code}. It expires in 10 minutes. Never share this code. If you did not request it, you can safely ignore this email.`,
  html: renderCirkleEmail({
    eyebrow: "Secure sign-in",
    title: "Your sign-in code",
    intro: "Use this one-time code to finish signing in or creating your Cirkle.World account.",
    code,
    detail: "This code expires in 10 minutes and can be used only once.",
    securityNote: "Never share this code. Cirkle.World will never ask for it by phone, chat, or message.",
  }),
});

export const passwordResetEmail = (actionUrl: string) => ({
  subject: "Reset your Cirkle.World password",
  text: `Use this secure link to reset your Cirkle.World password: ${actionUrl} The link is temporary and can be used only once. If you did not request a reset, ignore this email.`,
  html: renderCirkleEmail({
    eyebrow: "Account recovery",
    title: "Reset your password",
    intro: "Use the secure button below to choose a new password for your Cirkle.World account.",
    actionLabel: "Reset password",
    actionUrl,
    detail: "For your security, this link is temporary and can be used only once.",
    securityNote: "If you did not request a password reset, ignore this email and your password will remain unchanged.",
  }),
});

export const iitVerificationEmail = (code: string, iitName: string) => ({
  subject: `${code} verifies your ${iitName} email on Cirkle.World`,
  text: `Use code ${code} to verify your ${iitName} email on Cirkle.World. It expires in 10 minutes. Never share this code.`,
  html: renderCirkleEmail({
    eyebrow: "IIT identity verification",
    title: `Verify your ${iitName} email`,
    intro: "This confirms your institute email and unlocks your verified campus community.",
    code,
    codeLabel: "Verification code",
    detail: "This code expires in 10 minutes and can be used only once.",
    securityNote: "If you did not request IIT verification, ignore this email and your account will remain unchanged.",
  }),
});

export const documentDecisionEmail = (input: {
  approved: boolean;
  iitName: string;
  note?: string;
}) => {
  const title = input.approved ? "Your IIT verification is approved" : "Your verification needs attention";
  const intro = input.approved
    ? `Your ${input.iitName} document has been approved. Your verified Cirkle.World experience is ready.`
    : `We could not approve your ${input.iitName} document yet. You can review the note and submit another document.`;
  const detail = input.note ? `Review note: ${input.note}` : undefined;

  return {
    subject: input.approved ? "Your Cirkle.World IIT verification is approved" : "Action needed: Cirkle.World verification",
    text: `${intro}${detail ? ` ${detail}` : ""} Open Cirkle.World: https://cirkle.world/auth`,
    html: renderCirkleEmail({
      eyebrow: input.approved ? "Verification complete" : "Action required",
      title,
      intro,
      actionLabel: input.approved ? "Open Cirkle.World" : "Review verification",
      actionUrl: "https://cirkle.world/auth",
      detail,
      securityNote: "This decision was sent only to the login email connected to your Cirkle.World account.",
    }),
  };
};
