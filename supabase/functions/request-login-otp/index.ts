import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";
import { loginCodeEmail } from "../_shared/emailTemplate.ts";
import { sendTransactionalEmail } from "../_shared/emailDelivery.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const normalizeEmail = (value: unknown) => {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
};

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const bytesToHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const pepper = Deno.env.get("VERIFICATION_CODE_PEPPER");
    if (!supabaseUrl || !serviceKey || !pepper) return json({ error: "Login OTP service is not configured" }, 503);

    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const redirectTo = typeof body.redirect_to === "string" ? body.redirect_to : undefined;
    if (!isValidEmail(email)) return json({ error: "Enter a valid email address" }, 400);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const forwardedFor = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { data: allowed, error: rateError } = await admin.rpc("reserve_login_otp_attempt", {
      p_email_hash: await sha256Hex(`${pepper}:email:${email}`),
      p_ip_hash: await sha256Hex(`${pepper}:ip:${forwardedFor}`),
    });
    if (rateError) throw new Error("Login code rate limiter is unavailable");
    if (allowed !== true) return json({ error: "Too many code requests. Wait 15 minutes and try again." }, 429);
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (error) throw error;

    const code = data.properties?.email_otp;
    if (!code) throw new Error("Supabase did not return an email OTP");
    await sendTransactionalEmail({
      to: email,
      ...loginCodeEmail(code),
      idempotencyKey: `login-otp:${email}:${await sha256Hex(code)}`,
    });

    return json({ success: true });
  } catch (error) {
    console.error("request-login-otp failed", error instanceof Error ? error.message : error);
    return json({ error: error instanceof Error ? error.message : "Could not send login code" }, 500);
  }
});
