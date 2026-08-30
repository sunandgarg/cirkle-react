import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cirkle-dispatch-secret",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const publisherUrl = Deno.env.get("AWS_REALTIME_PUBLISHER_URL") || "";
  const bridgeSecret = Deno.env.get("AWS_REALTIME_BRIDGE_SECRET") || "";
  if (!supabaseUrl || !serviceKey || !publisherUrl || !bridgeSecret) {
    return json({ error: "Realtime delivery is not configured" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const internalSecret = request.headers.get("x-cirkle-dispatch-secret");
  if (internalSecret !== bridgeSecret) {
    const accessToken = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    if (authError || !authData.user) return json({ error: "Authentication required" }, 401);
  }

  const workerId = crypto.randomUUID();
  const { data: deliveries, error: claimError } = await admin.rpc("claim_realtime_delivery_batch", {
    p_limit: 100,
    p_worker: workerId,
  });
  if (claimError) return json({ error: claimError.message }, 500);
  if (!deliveries?.length) return json({ delivered: 0, pending: 0 });

  try {
    const publisherResponse = await fetch(publisherUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cirkle-delivery-secret": bridgeSecret,
      },
      body: JSON.stringify({ deliveries }),
      signal: AbortSignal.timeout(12_000),
    });
    const publisherResult = await publisherResponse.json().catch(() => ({}));
    if (!publisherResponse.ok) throw new Error(publisherResult?.error || `AWS publisher returned ${publisherResponse.status}`);

    const succeeded = (publisherResult.succeeded || []).map((id: unknown) => Number(id)).filter(Number.isFinite);
    const failed = (publisherResult.failed || []) as Array<{ id: number; error?: string }>;
    if (succeeded.length) await admin.rpc("complete_realtime_delivery", { p_ids: succeeded, p_error: null });
    for (const item of failed) {
      await admin.rpc("complete_realtime_delivery", {
        p_ids: [Number(item.id)],
        p_error: item.error || "AWS rejected the event",
      });
    }
    return json({ delivered: succeeded.length, failed: failed.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AWS delivery failed";
    await admin.rpc("complete_realtime_delivery", {
      p_ids: deliveries.map((item: { id: number }) => item.id),
      p_error: message,
    });
    console.error("dispatch-realtime-outbox failed", message);
    return json({ error: message, queued: deliveries.length }, 502);
  }
});
