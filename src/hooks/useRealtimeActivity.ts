import { useEffect, useState } from "react";

type EventTargetLike = {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
};

type VisibilityTarget = EventTargetLike & {
  hidden?: boolean;
  visibilityState?: DocumentVisibilityState;
};

type RealtimeActivityControllerOptions = {
  onActiveChange: (active: boolean) => void;
  idleMs?: number;
  windowTarget?: EventTargetLike;
  documentTarget?: VisibilityTarget;
};

export const REALTIME_BACKGROUND_IDLE_MS = 30_000;

/**
 * Keeps expensive room subscriptions alive only while the realtime screen is
 * usable. pagehide/freeze close immediately because mobile browsers can pause
 * JavaScript before a delayed timer gets another chance to run.
 */
export const createRealtimeActivityController = ({
  onActiveChange,
  idleMs = REALTIME_BACKGROUND_IDLE_MS,
  windowTarget = typeof window === "undefined" ? undefined : window,
  documentTarget = typeof document === "undefined" ? undefined : document,
}: RealtimeActivityControllerOptions) => {
  let disposed = false;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let active = !(documentTarget?.hidden || documentTarget?.visibilityState === "hidden");

  const setActive = (next: boolean) => {
    if (disposed || active === next) return;
    active = next;
    onActiveChange(next);
  };
  const clearHiddenTimer = () => {
    if (hiddenTimer !== null) clearTimeout(hiddenTimer);
    hiddenTimer = null;
  };
  const suspendAfterIdle = () => {
    clearHiddenTimer();
    hiddenTimer = setTimeout(() => {
      hiddenTimer = null;
      setActive(false);
    }, idleMs);
  };
  const handleVisibility: EventListener = () => {
    const hidden = documentTarget?.hidden || documentTarget?.visibilityState === "hidden";
    if (hidden) suspendAfterIdle();
    else {
      clearHiddenTimer();
      setActive(true);
    }
  };
  const handlePageHide: EventListener = () => {
    clearHiddenTimer();
    setActive(false);
  };
  const handlePageShow: EventListener = () => {
    const hidden = documentTarget?.hidden || documentTarget?.visibilityState === "hidden";
    if (!hidden) setActive(true);
  };

  documentTarget?.addEventListener("visibilitychange", handleVisibility);
  documentTarget?.addEventListener("freeze", handlePageHide);
  windowTarget?.addEventListener("pagehide", handlePageHide);
  windowTarget?.addEventListener("pageshow", handlePageShow);

  return {
    isActive: () => active,
    dispose: () => {
      disposed = true;
      clearHiddenTimer();
      documentTarget?.removeEventListener("visibilitychange", handleVisibility);
      documentTarget?.removeEventListener("freeze", handlePageHide);
      windowTarget?.removeEventListener("pagehide", handlePageHide);
      windowTarget?.removeEventListener("pageshow", handlePageShow);
    },
  };
};

export const useRealtimeActivity = (idleMs = REALTIME_BACKGROUND_IDLE_MS) => {
  const [active, setActive] = useState(() =>
    typeof document === "undefined" || !(document.hidden || document.visibilityState === "hidden"));

  useEffect(() => {
    const controller = createRealtimeActivityController({ onActiveChange: setActive, idleMs });
    setActive(controller.isActive());
    return controller.dispose;
  }, [idleMs]);

  return active;
};
