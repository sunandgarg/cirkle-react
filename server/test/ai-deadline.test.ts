import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_SCAN_NETWORK_DEADLINE_MS,
  AI_SCAN_PROVIDER_TIMEOUT_MS,
  AI_SCAN_SOURCE_TIMEOUT_MS,
  AI_SCAN_TOTAL_DEADLINE_MS,
  AI_SCAN_TRANSACTION_MAX_WAIT_MS,
  AI_SCAN_TRANSACTION_TIMEOUT_MS,
  commitWithinScanDeadline,
  createPhaseSignal,
  raceWithSignal,
  ScanDeadline,
} from "../src/services/scanDeadline.js";

describe("AI scan deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("keeps network, provider, source, and commit budgets below the proxy ceiling", () => {
    expect(AI_SCAN_TOTAL_DEADLINE_MS).toBeLessThan(55_000);
    expect(AI_SCAN_NETWORK_DEADLINE_MS).toBeLessThan(AI_SCAN_TOTAL_DEADLINE_MS);
    expect(AI_SCAN_SOURCE_TIMEOUT_MS).toBe(12_000);
    expect(AI_SCAN_PROVIDER_TIMEOUT_MS).toBe(30_000);
    expect(AI_SCAN_TRANSACTION_MAX_WAIT_MS + AI_SCAN_TRANSACTION_TIMEOUT_MS).toBeLessThan(
      AI_SCAN_TOTAL_DEADLINE_MS - AI_SCAN_NETWORK_DEADLINE_MS,
    );
  });

  it("aborts a provider phase at its own timeout", async () => {
    const deadline = new ScanDeadline(10_000, 8_000);
    const phase = createPhaseSignal(deadline.networkSignal, 1_000);
    const pending = raceWithSignal(new Promise<never>(() => undefined), phase.signal);
    const rejected = expect(pending).rejects.toThrow("phase_timeout");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(phase.timedOut()).toBe(true);
    await rejected;
    phase.dispose();
    deadline.dispose();
  });

  it("propagates the shared network cutoff without mislabeling it as a phase timeout", async () => {
    const deadline = new ScanDeadline(10_000, 1_000);
    const phase = createPhaseSignal(deadline.networkSignal, 8_000);
    const pending = raceWithSignal(new Promise<never>(() => undefined), phase.signal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 504, code: "scan_deadline_exceeded" });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(phase.timedOut()).toBe(false);
    await rejected;
    phase.dispose();
    deadline.dispose();
  });

  it("does not invoke the database writer when no safe commit window remains", async () => {
    const deadline = new ScanDeadline(10_000, 8_000);
    const writer = vi.fn(async () => "committed");
    await vi.advanceTimersByTimeAsync(3_501);
    await expect(commitWithinScanDeadline(deadline, writer)).rejects.toMatchObject({ status: 504, code: "scan_deadline_exceeded" });
    expect(writer).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("bounds transaction acquisition and execution and maps transaction timeout to a zero-import error", async () => {
    const deadline = new ScanDeadline();
    const writer = vi.fn(async ({ timeout, maxWait, assertActive }: { timeout: number; maxWait: number; assertActive(): void }) => {
      expect(timeout).toBe(AI_SCAN_TRANSACTION_TIMEOUT_MS);
      expect(maxWait).toBe(AI_SCAN_TRANSACTION_MAX_WAIT_MS);
      assertActive();
      throw Object.assign(new Error("transaction expired"), { code: "P2028" });
    });
    await expect(commitWithinScanDeadline(deadline, writer)).rejects.toMatchObject({ status: 504, code: "scan_commit_timeout" });
    expect(writer).toHaveBeenCalledOnce();
    deadline.dispose();
  });
});
