import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  advancePageChromeScroll,
  blurPointerFocusedChromeControl,
  createPageChromeScrollState,
  DEFAULT_PAGE_CHROME_SCROLL_OPTIONS,
  PAGE_CHROME_SCROLL_RUNWAY_CLASS,
  PAGE_CHROME_SCROLL_RUNWAY_PX,
  shouldKeepFocusedChromeExpanded,
  shouldKeepPageChromeExpanded,
  useCollapsiblePageChrome,
} from "@/hooks/useCollapsiblePageChrome";
import {
  COLLAPSIBLE_PAGE_CHROME_STACKING_CLASS,
  isCollapsiblePageChromeRoute,
  useRouteScopedPageChrome,
} from "@/contexts/PageChromeContext";

describe("mobile page chrome scroll direction", () => {
  it("collapses only after sustained travel toward the end", () => {
    let state = createPageChromeScrollState(0);
    state = advancePageChromeScroll(state, 20);
    expect(state.collapsed).toBe(false);

    state = advancePageChromeScroll(state, 46);
    expect(state.collapsed).toBe(true);
    expect(state.direction).toBe("toward-end");
  });

  it("reveals after a deliberate reverse gesture without changing scrollTop", () => {
    let state = createPageChromeScrollState(100, true);
    state = advancePageChromeScroll(state, 89);
    expect(state.collapsed).toBe(true);

    state = advancePageChromeScroll(state, 71);
    expect(state.collapsed).toBe(false);
    expect(state.lastScrollTop).toBe(71);
    expect(state.direction).toBe("toward-start");
  });

  it("resets hysteresis when gesture direction changes", () => {
    let state = createPageChromeScrollState(100, true);
    state = advancePageChromeScroll(state, 84);
    state = advancePageChromeScroll(state, 91);
    state = advancePageChromeScroll(state, 76);

    expect(state.collapsed).toBe(true);
    expect(state.directionalDistance).toBe(15);
  });

  it("always reveals at the top and clamps rubber-band positions", () => {
    const state = advancePageChromeScroll(createPageChromeScrollState(80, true), -24);
    expect(state).toEqual(createPageChromeScrollState(0, false));
  });

  it("ignores fractional scroll noise until it becomes meaningful travel", () => {
    const initial = createPageChromeScrollState(10);
    const afterNoise = advancePageChromeScroll(initial, 10.5);
    expect(afterNoise).toBe(initial);

    const afterTravel = advancePageChromeScroll(afterNoise, 12);
    expect(afterTravel.lastScrollTop).toBe(12);
    expect(afterTravel.directionalDistance).toBe(2);
  });

  it("keeps chrome expanded while an editable control has focus", () => {
    expect(shouldKeepPageChromeExpanded(document.createElement("input"))).toBe(true);
    expect(shouldKeepPageChromeExpanded(document.createElement("textarea"))).toBe(true);
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    expect(shouldKeepPageChromeExpanded(editor)).toBe(true);
    expect(shouldKeepPageChromeExpanded(document.createElement("button"))).toBe(false);
  });

  it("distinguishes pointer focus from keyboard-visible chrome focus", () => {
    const chrome = document.createElement("header");
    const filterButton = document.createElement("button");
    chrome.append(filterButton);
    const matches = vi.spyOn(filterButton, "matches");

    matches.mockReturnValue(false);
    expect(shouldKeepFocusedChromeExpanded(filterButton, chrome)).toBe(false);

    matches.mockImplementation((selector) => selector === ":focus-visible");
    expect(shouldKeepFocusedChromeExpanded(filterButton, chrome)).toBe(true);

    matches.mockReturnValue(false);
    filterButton.setAttribute("aria-expanded", "true");
    expect(shouldKeepFocusedChromeExpanded(document.body, chrome)).toBe(true);
  });

  it("blurs only pointer-focused controls before their chrome is hidden", () => {
    const chrome = document.createElement("header");
    const filterButton = document.createElement("button");
    chrome.append(filterButton);
    document.body.append(chrome);
    const matches = vi.spyOn(filterButton, "matches").mockReturnValue(false);

    try {
      filterButton.focus();
      expect(document.activeElement).toBe(filterButton);
      expect(blurPointerFocusedChromeControl(filterButton, chrome)).toBe(true);
      expect(chrome.contains(document.activeElement)).toBe(false);

      filterButton.focus();
      matches.mockImplementation((selector) => selector === ":focus-visible");
      expect(blurPointerFocusedChromeControl(filterButton, chrome)).toBe(false);
      expect(document.activeElement).toBe(filterButton);
    } finally {
      matches.mockRestore();
      chrome.remove();
    }
  });

  it("scopes shared chrome collapsing to Consult and Jobs only", () => {
    expect(isCollapsiblePageChromeRoute("/consult")).toBe(true);
    expect(isCollapsiblePageChromeRoute("/consult/bookings")).toBe(true);
    expect(isCollapsiblePageChromeRoute("/jobs/remote")).toBe(true);
    expect(isCollapsiblePageChromeRoute("/cirkle-forum")).toBe(false);
    expect(isCollapsiblePageChromeRoute("/chats/room-1")).toBe(false);
    expect(isCollapsiblePageChromeRoute("/jobs-board")).toBe(false);
  });

  it("keeps the expanded notification overlay above the profile reminder", () => {
    expect(COLLAPSIBLE_PAGE_CHROME_STACKING_CLASS).toContain("relative z-50");
    expect(COLLAPSIBLE_PAGE_CHROME_STACKING_CLASS).toContain("[&>header]:z-50");
  });

  it("wires native scroll events to the collapsed state", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    const scroller = document.createElement("main");
    const scrollRef = { current: scroller };
    const onCollapsedChange = vi.fn();
    try {
      const { result, unmount } = renderHook(() => useCollapsiblePageChrome(
        scrollRef,
        { onCollapsedChange },
      ));

      act(() => {
        scroller.scrollTop = 48;
        scroller.dispatchEvent(new Event("scroll"));
      });

      expect(result.current).toBe(true);
      expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
      unmount();
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("allows a pointer-focused filter to collapse with the next scroll", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    const scroller = document.createElement("div");
    const chrome = document.createElement("header");
    const filterButton = document.createElement("button");
    chrome.append(filterButton);
    scroller.append(chrome, document.createElement("div"));
    document.body.append(scroller);
    const scrollRef = { current: scroller };
    const chromeRef = { current: chrome };
    const matches = vi.spyOn(filterButton, "matches").mockReturnValue(false);

    try {
      const { result, unmount } = renderHook(() => useCollapsiblePageChrome(
        scrollRef,
        { keepExpandedWithinRef: chromeRef },
      ));

      filterButton.focus();
      act(() => {
        scroller.scrollTop = 48;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(result.current).toBe(true);
      expect(chrome.contains(document.activeElement)).toBe(false);

      unmount();
    } finally {
      matches.mockRestore();
      scroller.remove();
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("keeps chrome expanded while a keyboard-focused filter is focus-visible", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    const scroller = document.createElement("div");
    const chrome = document.createElement("header");
    const filterButton = document.createElement("button");
    chrome.append(filterButton);
    scroller.append(chrome, document.createElement("div"));
    document.body.append(scroller);
    const scrollRef = { current: scroller };
    const chromeRef = { current: chrome };
    const matches = vi.spyOn(filterButton, "matches")
      .mockImplementation((selector) => selector === ":focus-visible");

    try {
      const { result, unmount } = renderHook(() => useCollapsiblePageChrome(
        scrollRef,
        { keepExpandedWithinRef: chromeRef },
      ));

      filterButton.focus();
      act(() => {
        scroller.scrollTop = 48;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(result.current).toBe(false);
      expect(document.activeElement).toBe(filterButton);

      matches.mockReturnValue(false);
      act(() => {
        scroller.scrollTop = 96;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(result.current).toBe(true);
      unmount();
    } finally {
      matches.mockRestore();
      scroller.remove();
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("protects keyboard focus and releases pointer focus in shared top chrome", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    const scroller = document.createElement("div");
    const localChrome = document.createElement("header");
    const sharedChrome = document.createElement("header");
    const sharedButton = document.createElement("button");
    sharedChrome.append(sharedButton);
    scroller.append(sharedChrome, localChrome, document.createElement("div"));
    document.body.append(scroller);
    const scrollRef = { current: scroller };
    const localChromeRef = { current: localChrome };
    const sharedChromeRef = { current: sharedChrome };
    const matches = vi.spyOn(sharedButton, "matches")
      .mockImplementation((selector) => selector === ":focus-visible");

    try {
      const { result, unmount } = renderHook(() => useCollapsiblePageChrome(
        scrollRef,
        {
          keepExpandedWithinRef: localChromeRef,
          additionalKeepExpandedWithinRef: sharedChromeRef,
        },
      ));

      sharedButton.focus();
      act(() => {
        scroller.scrollTop = 48;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(result.current).toBe(false);
      expect(document.activeElement).toBe(sharedButton);

      matches.mockReturnValue(false);
      sharedButton.setAttribute("aria-expanded", "true");
      act(() => {
        scroller.scrollTop = 96;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(result.current).toBe(false);
      expect(document.activeElement).toBe(sharedButton);

      sharedButton.setAttribute("aria-expanded", "false");
      act(() => {
        scroller.scrollTop = 144;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(result.current).toBe(true);
      expect(sharedChrome.contains(document.activeElement)).toBe(false);
      unmount();
    } finally {
      matches.mockRestore();
      scroller.remove();
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("keeps a mobile runway longer than both gesture thresholds", () => {
    expect(PAGE_CHROME_SCROLL_RUNWAY_PX).toBeGreaterThanOrEqual(
      Math.max(
        DEFAULT_PAGE_CHROME_SCROLL_OPTIONS.collapseDistance,
        DEFAULT_PAGE_CHROME_SCROLL_OPTIONS.revealDistance,
      ),
    );
    expect(PAGE_CHROME_SCROLL_RUNWAY_CLASS).toContain("min-h-[calc(100%_+_4rem)]");
    expect(PAGE_CHROME_SCROLL_RUNWAY_CLASS).toContain("lg:min-h-0");
  });

  it("resets shared chrome immediately when the route changes", () => {
    const { result, rerender } = renderHook(
      ({ pathname }) => useRouteScopedPageChrome(pathname),
      { initialProps: { pathname: "/consult" } },
    );

    act(() => result.current.requestCollapsed(true));
    expect(result.current.collapsed).toBe(true);

    rerender({ pathname: "/jobs" });
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.requestCollapsed(true));
    expect(result.current.collapsed).toBe(true);

    rerender({ pathname: "/network" });
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.requestCollapsed(true));
    expect(result.current.collapsed).toBe(false);
  });
});
