import { describe, expect, it, vi } from "vitest";
import { createRealtimeActivityController } from "@/hooks/useRealtimeActivity";

describe("cost-aware realtime activity", () => {
  it("suspends immediately when a browser tab becomes hidden and resumes on return", () => {
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
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    documentTarget.hidden = false;
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    controller.dispose();
  });

  it("does not emit duplicate lifecycle states", () => {
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
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.hidden = false;
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(onActiveChange).toHaveBeenCalledTimes(2);
    expect(onActiveChange).toHaveBeenNthCalledWith(1, false);
    expect(onActiveChange).toHaveBeenNthCalledWith(2, true);
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
