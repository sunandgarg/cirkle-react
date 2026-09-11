import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useForumTimelineScrollState } from "@/hooks/useForumTimelineScrollState";

afterEach(() => vi.unstubAllGlobals());

describe("Forum short timeline scroll state", () => {
  it("reacts to viewport and rendered-content resizing without inventing scroll travel", () => {
    let notifyResize = () => {};
    const observed = new Set<Element>();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe(element: Element) { observed.add(element); }
      disconnect() { observed.clear(); }
      unobserve(element: Element) { observed.delete(element); }
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const scroller = document.createElement("div");
    const content = document.createElement("div");
    const chrome = document.createElement("div");
    const contentHeight = 500;
    let chromeHeight = 64;
    const clientHeight = 640;
    let scrollTop = 22;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => contentHeight + chromeHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });

    const scrollRef = { current: scroller };
    const contentRef = { current: content };
    const chromeRef = { current: chrome };
    const { result } = renderHook(() => useForumTimelineScrollState(
      scrollRef,
      contentRef,
      chromeRef,
      "room-a:1",
    ));

    expect(result.current).toBe("static");
    expect(scrollTop).toBe(0);
    expect(observed).toEqual(new Set([scroller, content, chrome]));

    act(() => {
      // Opening only the sticky search/header chrome creates real overflow.
      // The message content itself is unchanged.
      chromeHeight = 180;
      notifyResize();
    });
    expect(result.current).toBe("scrollable");

    act(() => {
      scrollTop = 70;
      chromeHeight = 64;
      notifyResize();
    });
    expect(result.current).toBe("static");
    expect(scrollTop).toBe(0);
  });

  it("remeasures synchronously when semantic chrome changes before the fallback frame", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const scheduledFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      scheduledFrames.push(callback);
      return scheduledFrames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const scroller = document.createElement("div");
    const content = document.createElement("div");
    const chrome = document.createElement("div");
    let scrollHeight = 500;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    const scrollRef = { current: scroller };
    const contentRef = { current: content };
    const chromeRef = { current: chrome };
    const { result, rerender } = renderHook(({ version }) => useForumTimelineScrollState(
      scrollRef,
      contentRef,
      chromeRef,
      version,
    ), { initialProps: { version: "room" } });

    expect(result.current).toBe("static");
    act(() => {
      scrollHeight = 760;
      rerender({ version: "search" });
    });
    expect(result.current).toBe("scrollable");

    act(() => {
      scrollHeight = 500;
      rerender({ version: "room" });
    });
    expect(result.current).toBe("static");
  });
});
