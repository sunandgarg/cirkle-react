import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeActivityController } from "@/hooks/useRealtimeActivity";

describe("cost-aware realtime activity", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a hidden tab connected for 30 seconds, then suspends it", () => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), {
      hidden: false,
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const onActiveChange = vi.fn();
    const controller = createRealtimeActivityController({
      onActiveChange,
      windowTarget,
      documentTarget,
    });

    documentTarget.hidden = true;
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(29_999);
    expect(onActiveChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    documentTarget.hidden = false;
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    controller.dispose();
  });

  it("cancels suspension when the user returns before 30 seconds", () => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), {
      hidden: false,
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const onActiveChange = vi.fn();
    const controller = createRealtimeActivityController({ onActiveChange, windowTarget, documentTarget });

    documentTarget.hidden = true;
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10_000);
    documentTarget.hidden = false;
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(30_000);

    expect(onActiveChange).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(true);
    controller.dispose();
  });

  it("disconnects immediately before a mobile browser freezes", () => {
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), {
      hidden: false,
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const onActiveChange = vi.fn();
    const controller = createRealtimeActivityController({ onActiveChange, windowTarget, documentTarget });

    windowTarget.dispatchEvent(new Event("pagehide"));
    expect(onActiveChange).toHaveBeenCalledWith(false);
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    controller.dispose();
  });
});
