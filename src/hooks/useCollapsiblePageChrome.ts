import { useEffect, useState, type RefObject } from "react";

export type PageChromeScrollDirection = "toward-end" | "toward-start" | null;

export interface PageChromeScrollState {
  collapsed: boolean;
  direction: PageChromeScrollDirection;
  directionalDistance: number;
  lastScrollTop: number;
}

export interface PageChromeScrollOptions {
  collapseDistance: number;
  revealDistance: number;
  revealAtTop: number;
}

export const DEFAULT_PAGE_CHROME_SCROLL_OPTIONS: PageChromeScrollOptions = {
  // Enough travel to distinguish an intentional gesture from touch jitter.
  collapseDistance: 44,
  // Revealing is slightly easier than hiding so controls remain discoverable.
  revealDistance: 28,
  revealAtTop: 2,
};

const safeScrollTop = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

export const shouldKeepPageChromeExpanded = (activeElement: Element | null) =>
  activeElement instanceof HTMLElement
  && (
    activeElement.matches("input, textarea")
    || activeElement.isContentEditable
    || activeElement.getAttribute("contenteditable") === "true"
  );

export const createPageChromeScrollState = (
  scrollTop = 0,
  collapsed = false,
): PageChromeScrollState => ({
  collapsed,
  direction: null,
  directionalDistance: 0,
  lastScrollTop: safeScrollTop(scrollTop),
});

/**
 * Converts native scroll positions into a stable mobile-chrome state.
 * Positive deltas mean the content is moving toward its end (a finger swiped
 * up), while negative deltas mean the user is deliberately returning toward
 * the start (a finger swiped down). It never writes scrollTop or cancels a
 * gesture, so momentum, direction-locking, and accessibility remain native.
 */
export const advancePageChromeScroll = (
  state: PageChromeScrollState,
  nextScrollTop: number,
  options: PageChromeScrollOptions = DEFAULT_PAGE_CHROME_SCROLL_OPTIONS,
): PageChromeScrollState => {
  const scrollTop = safeScrollTop(nextScrollTop);

  if (scrollTop <= options.revealAtTop) {
    return createPageChromeScrollState(scrollTop, false);
  }

  const delta = scrollTop - state.lastScrollTop;
  // Fractional layout/trackpad noise should not reset a real gesture. Keeping
  // the previous anchor lets tiny deltas accumulate naturally.
  if (Math.abs(delta) < 1) return state;

  const direction: PageChromeScrollDirection = delta > 0 ? "toward-end" : "toward-start";
  const directionalDistance = state.direction === direction
    ? state.directionalDistance + Math.abs(delta)
    : Math.abs(delta);

  let collapsed = state.collapsed;
  if (!collapsed && direction === "toward-end" && directionalDistance >= options.collapseDistance) {
    collapsed = true;
  } else if (collapsed && direction === "toward-start" && directionalDistance >= options.revealDistance) {
    collapsed = false;
  }

  return {
    collapsed,
    direction,
    directionalDistance,
    lastScrollTop: scrollTop,
  };
};

interface UseCollapsiblePageChromeOptions extends Partial<PageChromeScrollOptions> {
  /** The mobile/tablet layout ends where the permanent desktop sidebar begins. */
  mediaQuery?: string;
  /** Ignore scrollTop clamping caused by the chrome's own height transition. */
  layoutSettleMs?: number;
  /** Synchronises route-owned chrome with the shared application shell. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Reinitialises both local and shared chrome when the route changes. */
  resetKey?: string;
}

export const useCollapsiblePageChrome = (
  scrollRef: RefObject<HTMLElement | null>,
  {
    collapseDistance = DEFAULT_PAGE_CHROME_SCROLL_OPTIONS.collapseDistance,
    layoutSettleMs = 220,
    mediaQuery: mediaQueryValue = "(max-width: 1023px)",
    onCollapsedChange,
    resetKey,
    revealAtTop = DEFAULT_PAGE_CHROME_SCROLL_OPTIONS.revealAtTop,
    revealDistance = DEFAULT_PAGE_CHROME_SCROLL_OPTIONS.revealDistance,
  }: UseCollapsiblePageChromeOptions = {},
) => {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    setCollapsed(false);
    onCollapsedChange?.(false);

    const resolvedOptions: PageChromeScrollOptions = {
      collapseDistance,
      revealDistance,
      revealAtTop,
    };
    const mediaQuery = window.matchMedia(mediaQueryValue);
    let tracker = createPageChromeScrollState(scroller.scrollTop);
    let chromeIsCollapsed = false;
    let ignoreLayoutScrollUntil = 0;
    let animationFrame = 0;

    const setChrome = (nextCollapsed: boolean, now: number) => {
      if (chromeIsCollapsed === nextCollapsed) return;
      chromeIsCollapsed = nextCollapsed;
      setCollapsed(nextCollapsed);
      onCollapsedChange?.(nextCollapsed);
      ignoreLayoutScrollUntil = now + layoutSettleMs;
      tracker = createPageChromeScrollState(scroller.scrollTop, nextCollapsed);
    };

    const sampleScroll = () => {
      animationFrame = 0;
      const scrollTop = safeScrollTop(scroller.scrollTop);
      const now = performance.now();

      if (!mediaQuery.matches) {
        setChrome(false, now);
        tracker = createPageChromeScrollState(scrollTop, false);
        return;
      }

      // The top is authoritative even during a layout transition or rubber-band
      // overscroll, preventing a hidden header after returning to the start.
      if (scrollTop <= resolvedOptions.revealAtTop) {
        setChrome(false, now);
        tracker = createPageChromeScrollState(scrollTop, false);
        return;
      }

      // Software keyboards and focused editors can synthesize scroll events.
      // Keep search controls stable while the member is typing.
      if (shouldKeepPageChromeExpanded(document.activeElement)) {
        setChrome(false, now);
        tracker = createPageChromeScrollState(scrollTop, false);
        return;
      }

      if (now < ignoreLayoutScrollUntil) {
        tracker = createPageChromeScrollState(scrollTop, chromeIsCollapsed);
        return;
      }

      const next = advancePageChromeScroll(tracker, scrollTop, resolvedOptions);
      const changed = next.collapsed !== chromeIsCollapsed;
      tracker = next;
      if (changed) setChrome(next.collapsed, now);
    };

    const handleScroll = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(sampleScroll);
    };

    const handleMediaChange = () => {
      const now = performance.now();
      if (!mediaQuery.matches) setChrome(false, now);
      tracker = createPageChromeScrollState(scroller.scrollTop, mediaQuery.matches && chromeIsCollapsed);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });
    mediaQuery.addEventListener?.("change", handleMediaChange);
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      mediaQuery.removeEventListener?.("change", handleMediaChange);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      onCollapsedChange?.(false);
    };
  }, [
    collapseDistance,
    layoutSettleMs,
    mediaQueryValue,
    onCollapsedChange,
    resetKey,
    revealAtTop,
    revealDistance,
    scrollRef,
  ]);

  return collapsed;
};
