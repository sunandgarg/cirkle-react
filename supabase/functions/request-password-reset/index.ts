import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";
import { sendTransactionalEmail } from "../_shared/emailDelivery.ts";
import { passwordResetEmail } from "../_shared/emailTemplate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const normalizeEmail = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const pepper = Deno.env.get("VERIFICATION_CODE_PEPPER");
    if (!supabaseUrl || !serviceKey || !pepper) {
      return json({ error: "Password recovery service is not configured" }, 503);
    }

    const body = await request.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return json({ error: "Enter a valid email address" }, 400);
    const requestedRedirect = typeof body.redirect_to === "string" ? body.redirect_to : "";
    const redirectTo = /^https:\/\/(www\.)?cirkle\.world\/reset-password(?:[?#].*)?$/.test(requestedRedirect)
      ? requestedRedirect
      : "https://cirkle.world/reset-password";

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const forwardedFor = request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { data: allowed, error: rateError } = await admin.rpc("reserve_login_otp_attempt", {
      p_email_hash: await sha256Hex(`${pepper}:recovery-email:${email}`),
      p_ip_hash: await sha256Hex(`${pepper}:recovery-ip:${forwardedFor}`),
    });
    if (rateError) throw new Error("Password recovery rate limiter is unavailable");
    if (allowed !== true) return json({ error: "Too many requests. Wait 15 minutes and try again." }, 429);

    const { data, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo },
    });

    // Never reveal whether an address belongs to a Cirkle account.
    if (error || !data.properties?.action_link) {
      console.warn("Password reset link was not generated for the requested address");
      return json({ success: true });
    }

    const actionUrl = data.properties.action_link;
    await sendTransactionalEmail({
      to: email,
      ...passwordResetEmail(actionUrl),
      idempotencyKey: `password-reset:${await sha256Hex(actionUrl)}`,
    });
    return json({ success: true });
  } catch (error) {
    console.error("request-password-reset failed", error instanceof Error ? error.message : error);
    return json({ error: "Could not send the recovery email. Try again shortly." }, 502);
  }
});
