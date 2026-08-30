type RecoveryTarget = {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
};

type RealtimeRecoveryOptions = {
  recover: () => Promise<void>;
  ensureConnected?: () => void;
  windowTarget?: RecoveryTarget;
  documentTarget?: RecoveryTarget & { visibilityState?: DocumentVisibilityState };
  isOnline?: () => boolean;
  healthCheckIntervalMs?: number;
};

/**
 * Coalesces lifecycle-driven history reconciliation for realtime screens.
 * WebSockets are a low-latency notification path; the database remains the
 * durable source of truth whenever a browser wakes, reconnects or regains focus.
 */
export const createRealtimeRecoveryController = ({
  recover,
  ensureConnected,
  windowTarget = typeof window === "undefined" ? undefined : window,
  documentTarget = typeof document === "undefined" ? undefined : document,
  isOnline = () => typeof navigator === "undefined" || navigator.onLine,
  healthCheckIntervalMs = 30_000,
}: RealtimeRecoveryOptions) => {
  let disposed = false;
  let running: Promise<void> | null = null;
  let rerunRequested = false;

  const isVisible = () => !documentTarget?.visibilityState || documentTarget.visibilityState === "visible";

  const recoverNow = () => {
    if (disposed || !isOnline() || !isVisible()) return Promise.resolve();
    ensureConnected?.();
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      do {
        rerunRequested = false;
        await recover();
      } while (!disposed && rerunRequested && isOnline() && isVisible());
    })().catch(() => undefined).finally(() => { running = null; });
    return running;
  };

  const handleRecoveryEvent: EventListener = () => { void recoverNow(); };
  const handleVisibility: EventListener = () => {
    if (isVisible()) void recoverNow();
  };
  windowTarget?.addEventListener("online", handleRecoveryEvent);
  windowTarget?.addEventListener("focus", handleRecoveryEvent);
  documentTarget?.addEventListener("visibilitychange", handleVisibility);

  // This timer only repairs channel health. It does not poll the database,
  // avoiding one recurring query per connected user at large scale.
  const healthTimer = ensureConnected && typeof setInterval !== "undefined"
    ? setInterval(() => {
        if (!disposed && isOnline() && isVisible()) ensureConnected();
      }, healthCheckIntervalMs)
    : null;

  return {
    recoverNow,
    dispose: () => {
      disposed = true;
      windowTarget?.removeEventListener("online", handleRecoveryEvent);
      windowTarget?.removeEventListener("focus", handleRecoveryEvent);
      documentTarget?.removeEventListener("visibilitychange", handleVisibility);
      if (healthTimer !== null) clearInterval(healthTimer);
    },
  };
};
