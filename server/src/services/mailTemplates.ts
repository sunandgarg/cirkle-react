export const CIRKLE_LOGO_CID = "cirkle-logo";

export interface TransactionalMailContent {
  subject: string;
  text: string;
  html: string;
}

interface CirkleTemplateInput {
  eyebrow: string;
  title: string;
  intro: string;
  securityNote: string;
  actionLabel?: string;
  actionUrl?: string;
  code?: string;
  codeLabel?: string;
  detail?: string;
}

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
}[character] ?? character));

function safeActionUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Email action URL must be an absolute HTTP(S) URL");
  }
  if (!new Set(["https:", "http:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Email action URL must be a credential-free HTTP(S) URL");
  }
  return parsed.toString();
}

export function renderCirkleEmail(input: CirkleTemplateInput): string {
  const eyebrow = escapeHtml(input.eyebrow);
  const title = escapeHtml(input.title);
  const intro = escapeHtml(input.intro);
  const securityNote = escapeHtml(input.securityNote);
  const detail = input.detail ? escapeHtml(input.detail) : "";
  const code = input.code ? escapeHtml(input.code) : "";
  const codeLabel = escapeHtml(input.codeLabel ?? "Your secure code");
  const actionLabel = input.actionLabel ? escapeHtml(input.actionLabel) : "";
  const actionUrl = input.actionUrl ? escapeHtml(safeActionUrl(input.actionUrl)) : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light">
    <title>${title}</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { padding: 16px 8px !important; }
        .email-card { border-radius: 18px !important; }
        .email-header, .email-body, .email-footer { padding-left: 22px !important; padding-right: 22px !important; }
        .email-title { font-size: 25px !important; line-height: 32px !important; }
        .email-code { font-size: 30px !important; letter-spacing: .17em !important; }
        .email-button { display: block !important; text-align: center !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f3f6fb;color:#101828;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${intro}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6fb;">
      <tr>
        <td class="email-shell" align="center" style="padding:32px 12px;">
          <table class="email-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:580px;background:#ffffff;border:1px solid #e4eaf2;border-radius:24px;box-shadow:0 18px 48px rgba(16,24,40,.08);overflow:hidden;">
            <tr><td style="height:6px;background:#2563eb;font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr>
              <td class="email-header" style="padding:28px 32px 14px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding-right:12px;vertical-align:middle;">
                      <img src="cid:${CIRKLE_LOGO_CID}" width="44" height="44" alt="Cirkle.World" style="display:block;width:44px;height:44px;border:0;border-radius:12px;">
                    </td>
                    <td style="vertical-align:middle;">
                      <div style="font-size:18px;line-height:22px;font-weight:800;letter-spacing:-.02em;color:#101828;">Cirkle.World</div>
                      <div style="margin-top:2px;font-size:12px;line-height:17px;color:#667085;">Verified communities. Useful connections.</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="email-body" style="padding:14px 32px 32px;">
                <div style="font-size:12px;line-height:18px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#2563eb;">${eyebrow}</div>
                <h1 class="email-title" style="margin:10px 0 12px;font-size:29px;line-height:37px;letter-spacing:-.03em;color:#101828;">${title}</h1>
                <p style="margin:0;font-size:16px;line-height:25px;color:#667085;">${intro}</p>
                ${code ? `<div style="margin:26px 0 22px;padding:20px 18px;text-align:center;background:#f8fafc;border:1px solid #e4eaf2;border-radius:18px;"><div style="font-size:12px;line-height:18px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#667085;">${codeLabel}</div><div class="email-code" style="margin-top:10px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:34px;line-height:42px;font-weight:800;letter-spacing:.22em;color:#101828;">${code}</div></div>` : ""}
                ${actionUrl && actionLabel ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 22px;"><tr><td style="border-radius:12px;background:#2563eb;"><a class="email-button" href="${actionUrl}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:15px;line-height:20px;font-weight:800;border-radius:12px;">${actionLabel}</a></td></tr></table>` : ""}
                ${detail ? `<p style="margin:0 0 20px;font-size:14px;line-height:22px;color:#667085;">${detail}</p>` : ""}
                <div style="padding:14px 16px;border:1px solid #dbeafe;border-radius:14px;background:#eff6ff;font-size:13px;line-height:20px;color:#344054;"><strong style="color:#1d4ed8;">Security note:</strong> ${securityNote}</div>
              </td>
            </tr>
            <tr>
              <td class="email-footer" style="padding:20px 32px;border-top:1px solid #edf0f5;font-size:12px;line-height:19px;color:#98a2b3;">
                Sent by Cirkle.World &middot; <a href="https://cirkle.world/privacy" style="color:#667085;">Privacy</a> &middot; <a href="https://cirkle.world/terms" style="color:#667085;">Terms</a><br>
                This is an automated account-security message. Please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function loginCodeEmail(code: string): TransactionalMailContent {
  return {
    subject: "Your Cirkle.World sign-in code",
    text: `Your Cirkle.World sign-in code is ${code}. It expires in 10 minutes and can be used only once. Never share this code. If you did not request it, you can safely ignore this email.`,
    html: renderCirkleEmail({
      eyebrow: "Secure sign-in",
      title: "Your sign-in code",
      intro: "Use this one-time code to finish signing in or creating your Cirkle.World account.",
      code,
      detail: "This code expires in 10 minutes and can be used only once.",
      securityNote: "Never share this code. Cirkle.World will never ask for it by phone, chat, or message.",
    }),
  };
}

export function instituteVerificationEmail(code: string): TransactionalMailContent {
  return {
    subject: "Verify your institute email on Cirkle.World",
    text: `Use code ${code} to verify your institute email on Cirkle.World. It expires in 10 minutes and can be used only once. Never share this code.`,
    html: renderCirkleEmail({
      eyebrow: "IIT identity verification",
      title: "Verify your institute email",
      intro: "This confirms your institute email and unlocks your verified campus community.",
      code,
      codeLabel: "Verification code",
      detail: "This code expires in 10 minutes and can be used only once.",
      securityNote: "If you did not request IIT verification, ignore this email and your account will remain unchanged.",
    }),
  };
}

export function passwordResetEmail(actionUrl: string): TransactionalMailContent {
  const safeUrl = safeActionUrl(actionUrl);
  return {
    subject: "Reset your Cirkle.World password",
    text: `Use this secure link to reset your Cirkle.World password: ${safeUrl} The link expires in 30 minutes and can be used only once. If you did not request a reset, ignore this email.`,
    html: renderCirkleEmail({
      eyebrow: "Account recovery",
      title: "Reset your password",
      intro: "Use the secure button below to choose a new password for your Cirkle.World account.",
      actionLabel: "Reset password",
      actionUrl: safeUrl,
      detail: "For your security, this link expires in 30 minutes and can be used only once.",
      securityNote: "If you did not request a password reset, ignore this email and your password will remain unchanged.",
    }),
  };
}

export function verificationDecisionEmail(approved: boolean, reason?: string): TransactionalMailContent {
  const title = approved ? "Your IIT verification is approved" : "Your verification needs attention";
  const intro = approved
    ? "Your institute verification has been approved. Your verified Cirkle.World experience is ready."
    : "We could not approve your verification yet. Review the note below and submit another document.";
  const detail = reason?.trim() ? `Review note: ${reason.trim()}` : undefined;
  const actionUrl = "https://cirkle.world/auth";
  return {
    subject: approved ? "Your Cirkle.World IIT verification is approved" : "Action needed: Cirkle.World verification",
    text: `${intro}${detail ? ` ${detail}` : ""} Open Cirkle.World: ${actionUrl}`,
    html: renderCirkleEmail({
      eyebrow: approved ? "Verification complete" : "Action required",
      title,
      intro,
      actionLabel: approved ? "Open Cirkle.World" : "Review verification",
      actionUrl,
      detail,
      securityNote: "This decision was sent only to the login email connected to your Cirkle.World account.",
    }),
  };
}
