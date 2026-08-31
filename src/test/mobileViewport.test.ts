import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isEditableElementActive, useScrollBehavior } from "@/hooks/useScrollBehavior";
import { resolveVisualViewportHeight } from "@/hooks/useVisualViewportHeight";

afterEach(() => vi.unstubAllGlobals());

describe("mobile forum viewport", () => {
  it("uses the visible viewport while the software keyboard is open", () => {
    expect(resolveVisualViewportHeight(412.4, 844)).toBe(412);
    expect(resolveVisualViewportHeight(undefined, 844)).toBe(844);
  });

  it("recognises active chat editors so scroll chrome cannot hide them", () => {
    const textarea = document.createElement("textarea");
    const input = document.createElement("input");
    const button = document.createElement("button");
    expect(isEditableElementActive(textarea)).toBe(true);
    expect(isEditableElementActive(input)).toBe(true);
    expect(isEditableElementActive(button)).toBe(false);
  });

  it("keeps the composer visible during keyboard-driven message scrolling", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });

    const scroller = document.createElement("div");
    let scrollTop = 300;
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; } },
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
    });
    const ref = { current: scroller };
    const { result } = renderHook(() => useScrollBehavior(ref));

    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
      scrollTop = 200;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.showInput).toBe(false);

    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    act(() => {
      scrollTop = 100;
      scroller.dispatchEvent(new Event("scroll"));
    });

    expect(result.current.showInput).toBe(true);
    composer.remove();
  });
});
