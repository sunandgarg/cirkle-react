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
  windowTarget?: EventTargetLike;
  documentTarget?: VisibilityTarget;
};

/**
 * Keeps expensive room subscriptions alive only while the realtime screen is
 * visible. Browsers may throttle or freeze background JavaScript immediately,
 * so visibilitychange, pagehide and freeze all suspend synchronously.
 */
export const createRealtimeActivityController = ({
  onActiveChange,
  windowTarget = typeof window === "undefined" ? undefined : window,
  documentTarget = typeof document === "undefined" ? undefined : document,
}: RealtimeActivityControllerOptions) => {
  let disposed = false;
  let active = !(documentTarget?.hidden || documentTarget?.visibilityState === "hidden");

  const setActive = (next: boolean) => {
    if (disposed || active === next) return;
    active = next;
    onActiveChange(next);
  };
  const handleVisibility: EventListener = () => {
    const hidden = documentTarget?.hidden || documentTarget?.visibilityState === "hidden";
    setActive(!hidden);
  };
  const handlePageHide: EventListener = () => {
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
      documentTarget?.removeEventListener("visibilitychange", handleVisibility);
      documentTarget?.removeEventListener("freeze", handlePageHide);
      windowTarget?.removeEventListener("pagehide", handlePageHide);
      windowTarget?.removeEventListener("pageshow", handlePageShow);
    },
  };
};

export const useRealtimeActivity = () => {
  const [active, setActive] = useState(() =>
    typeof document === "undefined" || !(document.hidden || document.visibilityState === "hidden"));

  useEffect(() => {
    const controller = createRealtimeActivityController({ onActiveChange: setActive });
    setActive(controller.isActive());
    return controller.dispose;
  }, []);

  return active;
};
