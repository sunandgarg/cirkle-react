import { supabase } from "@/integrations/supabase/client";
import { reportError } from "@/lib/errorTelemetry";

export type JobEngagementEvent =
  | "jobs_page_view"
  | "job_view_click"
  | "job_easy_apply_click"
  | "job_save"
  | "job_unsave"
  | "job_filter";

const getSessionId = () => {
  if (typeof window === "undefined") return "server-session";
  const key = "cirkle:job-analytics-session";
  const current = sessionStorage.getItem(key);
  if (current) return current;
  const value = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem(key, value);
  return value;
};

export const recordJobEngagement = async (
  eventName: JobEngagementEvent,
  jobId?: string | null,
  metadata: Record<string, string | number | boolean | null> = {},
) => {
  try {
    const { error } = await (supabase as any).rpc("record_job_engagement", {
      p_event_name: eventName,
      p_job_id: jobId || null,
      p_session_id: getSessionId(),
      p_metadata: metadata,
    });
    if (error) throw error;
  } catch (error) {
    reportError(error, {
      flow: "job_analytics",
      action: eventName,
      severity: "warning",
      metadata: { jobId: jobId || null },
    });
  }
};

