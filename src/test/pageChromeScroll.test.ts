import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  advancePageChromeScroll,
  createPageChromeScrollState,
  shouldKeepPageChromeExpanded,
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
