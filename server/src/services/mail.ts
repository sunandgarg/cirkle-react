import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";

interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendMail(input: MailInput): Promise<void> {
  if (!config.ZEPTOMAIL_TOKEN) {
    if (config.NODE_ENV === "production") throw new ApiError(503, "mail_not_configured", "Email delivery is not configured");
    return;
  }

  const response = await fetch(config.ZEPTOMAIL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Zoho-enczapikey ${config.ZEPTOMAIL_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      from: { address: config.ZEPTOMAIL_FROM_EMAIL, name: config.ZEPTOMAIL_FROM_NAME },
      to: [{ email_address: { address: input.to } }],
      subject: input.subject,
      htmlbody: input.html,
      textbody: input.text,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    const providerRequestId = response.headers.get("x-request-id") ?? undefined;
    throw new ApiError(502, "mail_delivery_failed", "The email provider rejected the message", { provider_request_id: providerRequestId });
  }
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[char] ?? char));

export async function sendLoginCode(email: string, code: string): Promise<void> {
  await sendMail({
    to: email,
    subject: "Your Cirkle sign-in code",
    text: `Your Cirkle sign-in code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your Cirkle sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p><p>It expires in 10 minutes.</p>`,
  });
}

export async function sendInstituteCode(email: string, code: string): Promise<void> {
  await sendMail({
    to: email,
    subject: "Verify your institute email",
    text: `Your Cirkle institute verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your institute verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p><p>It expires in 10 minutes.</p>`,
  });
}

export async function sendPasswordReset(email: string, url: string): Promise<void> {
  const safeUrl = escapeHtml(url);
  await sendMail({
    to: email,
    subject: "Reset your Cirkle password",
    text: `Reset your password using this link: ${url}. It expires in 30 minutes.`,
    html: `<p>Use the link below to reset your password. It expires in 30 minutes.</p><p><a href="${safeUrl}">Reset password</a></p>`,
  });
}

export async function sendVerificationDecision(email: string, approved: boolean, reason?: string): Promise<void> {
  const message = approved ? "Your Cirkle verification was approved." : `Your Cirkle verification was not approved.${reason ? ` Reason: ${reason}` : ""}`;
  await sendMail({ to: email, subject: "Cirkle verification update", text: message, html: `<p>${escapeHtml(message)}</p>` });
}
