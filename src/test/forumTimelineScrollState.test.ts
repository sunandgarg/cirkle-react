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
    let scrollHeight = 500;
    let clientHeight = 640;
    let scrollTop = 22;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });

    const scrollRef = { current: scroller };
    const contentRef = { current: content };
    const { result } = renderHook(() => useForumTimelineScrollState(
      scrollRef,
      contentRef,
      "room-a:1",
    ));

    expect(result.current).toBe("static");
    expect(scrollTop).toBe(0);
    expect(observed).toEqual(new Set([scroller, content]));

    act(() => {
      scrollHeight = 900;
      notifyResize();
    });
    expect(result.current).toBe("scrollable");

    act(() => {
      scrollTop = 70;
      clientHeight = 920;
      notifyResize();
    });
    expect(result.current).toBe("static");
    expect(scrollTop).toBe(0);
  });
});
