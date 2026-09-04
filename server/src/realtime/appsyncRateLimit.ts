interface WindowState {
  startedAt: number;
  count: number;
}
export interface AppSyncRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * A small in-process limiter for authenticated AppSync bridge requests.
 * Production currently runs one PM2 process, so this is also the effective
 * process-wide limit. The global HTTP limiter remains a separate outer guard.
 */
export class AppSyncFixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string, now = Date.now()): AppSyncRateLimitDecision {
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.makeRoom(now);
      this.windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((current.startedAt + this.windowMs - now) / 1_000));
    if (current.count >= this.limit) return { allowed: false, retryAfterSeconds };
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, value] of this.windows) {
      if (now - value.startedAt >= this.windowMs) this.windows.delete(key);
    }
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value as string | undefined;
      if (!oldest) break;
      this.windows.delete(oldest);
    }
  }
}
