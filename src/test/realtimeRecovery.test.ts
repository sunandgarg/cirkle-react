import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeRecoveryController } from "@/lib/realtimeRecovery";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("realtime lifecycle recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("reconciles durable history on focus, network recovery and foreground resume", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const recover = vi.fn(async () => undefined);
    const controller = createRealtimeRecoveryController({
      recover,
      windowTarget: windowTarget as any,
      documentTarget: documentTarget as any,
    });

    windowTarget.dispatchEvent(new Event("focus"));
    await flush();
    windowTarget.dispatchEvent(new Event("online"));
    await flush();
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await flush();
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await flush();

    expect(recover).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("coalesces overlapping wake events into one follow-up reconciliation", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    let release: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => { release = resolve; });
    const recover = vi.fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(undefined);
    const controller = createRealtimeRecoveryController({
      recover,
      windowTarget: windowTarget as any,
      documentTarget: documentTarget as any,
    });

    windowTarget.dispatchEvent(new Event("focus"));
    windowTarget.dispatchEvent(new Event("online"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(recover).toHaveBeenCalledTimes(1);
    release?.();
    await flush();

    expect(recover).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("repairs channel health without polling message history", () => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const recover = vi.fn(async () => undefined);
    const ensureConnected = vi.fn();
    const controller = createRealtimeRecoveryController({
      recover,
      ensureConnected,
      healthCheckIntervalMs: 1_000,
      windowTarget: windowTarget as any,
      documentTarget: documentTarget as any,
    });

    vi.advanceTimersByTime(3_000);
    expect(ensureConnected).toHaveBeenCalledTimes(3);
    expect(recover).not.toHaveBeenCalled();
    controller.dispose();
  });
});
