import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordJobEngagement } from "@/lib/jobAnalytics";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/lib/errorTelemetry", () => ({ reportError: vi.fn() }));

describe("job engagement analytics", () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.rpc.mockReset().mockResolvedValue({ error: null });
  });

  it("records job page and outbound click events with one tab session", async () => {
    await recordJobEngagement("jobs_page_view", null, { path: "/jobs" });
    await recordJobEngagement("job_view_click", "job-1", { company: "Cirkle" });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "record_job_engagement", expect.objectContaining({
      p_event_name: "jobs_page_view", p_job_id: null,
    }));
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "record_job_engagement", expect.objectContaining({
      p_event_name: "job_view_click", p_job_id: "job-1",
    }));
    expect(mocks.rpc.mock.calls[0][1].p_session_id).toBe(mocks.rpc.mock.calls[1][1].p_session_id);
  });
});
