import { ApiError } from "../lib/errors.js";

export const AI_SCAN_TOTAL_DEADLINE_MS = 50_000;
export const AI_SCAN_NETWORK_DEADLINE_MS = 42_000;
export const AI_SCAN_PROVIDER_TIMEOUT_MS = 30_000;
export const AI_SCAN_SOURCE_TIMEOUT_MS = 12_000;
export const AI_SCAN_TRANSACTION_MAX_WAIT_MS = 500;
export const AI_SCAN_TRANSACTION_TIMEOUT_MS = 5_000;
export const AI_SCAN_RESPONSE_RESERVE_MS = 1_500;
export const AI_SCAN_MIN_WRITE_WINDOW_MS = AI_SCAN_TRANSACTION_MAX_WAIT_MS + AI_SCAN_TRANSACTION_TIMEOUT_MS + AI_SCAN_RESPONSE_RESERVE_MS;

export const scanDeadlineError = (): ApiError => new ApiError(
  504,
  "scan_deadline_exceeded",
  "The scan exceeded its safe processing deadline; no listings were imported",
);

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? scanDeadlineError();
}

export async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

export interface PhaseSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

export function createPhaseSignal(parent: AbortSignal, timeoutMs: number): PhaseSignal {
  const controller = new AbortController();
  let localTimeout = false;
  const abortFromParent = () => controller.abort(abortError(parent));
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    localTimeout = true;
    controller.abort(new Error("phase_timeout"));
  }, Math.max(1, timeoutMs));
  unref(timer);
  return {
    signal: controller.signal,
    timedOut: () => localTimeout,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

export class ScanDeadline {
  readonly startedAt: number;
  readonly totalDeadlineAt: number;
  readonly networkSignal: AbortSignal;
  readonly #networkController = new AbortController();
  readonly #networkTimer: ReturnType<typeof setTimeout>;

  constructor(
    readonly totalMs = AI_SCAN_TOTAL_DEADLINE_MS,
    readonly networkMs = AI_SCAN_NETWORK_DEADLINE_MS,
    startedAt = Date.now(),
  ) {
    if (!Number.isFinite(totalMs) || !Number.isFinite(networkMs) || totalMs <= 0 || networkMs <= 0 || networkMs >= totalMs) {
      throw new Error("Invalid scan deadline configuration");
    }
    this.startedAt = startedAt;
    this.totalDeadlineAt = startedAt + totalMs;
    this.networkSignal = this.#networkController.signal;
    this.#networkTimer = setTimeout(() => this.#networkController.abort(scanDeadlineError()), networkMs);
    unref(this.#networkTimer);
  }

  assertNetworkActive(): void {
    if (this.networkSignal.aborted || Date.now() >= this.startedAt + this.networkMs) throw scanDeadlineError();
  }

  assertCommitActive(): void {
    if (Date.now() >= this.totalDeadlineAt - AI_SCAN_RESPONSE_RESERVE_MS) throw scanDeadlineError();
  }

  transactionTimeoutMs(): number {
    const remaining = this.totalDeadlineAt - Date.now();
    if (remaining < AI_SCAN_MIN_WRITE_WINDOW_MS) throw scanDeadlineError();
    return Math.min(
      AI_SCAN_TRANSACTION_TIMEOUT_MS,
      remaining - AI_SCAN_TRANSACTION_MAX_WAIT_MS - AI_SCAN_RESPONSE_RESERVE_MS,
    );
  }

  async network<T>(operation: Promise<T>): Promise<T> {
    this.assertNetworkActive();
    return raceWithSignal(operation, this.networkSignal);
  }

  dispose(): void {
    clearTimeout(this.#networkTimer);
  }
}

interface CommitControls {
  timeout: number;
  maxWait: number;
  assertActive(): void;
}

export async function commitWithinScanDeadline<T>(
  deadline: ScanDeadline,
  writer: (controls: CommitControls) => Promise<T>,
): Promise<T> {
  const timeout = deadline.transactionTimeoutMs();
  try {
    return await writer({ timeout, maxWait: AI_SCAN_TRANSACTION_MAX_WAIT_MS, assertActive: () => deadline.assertCommitActive() });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "P2028" || Date.now() >= deadline.totalDeadlineAt - AI_SCAN_RESPONSE_RESERVE_MS) {
      throw new ApiError(504, "scan_commit_timeout", "The scan could not be committed within its safe deadline; no listings were imported");
    }
    throw error;
  }
}
