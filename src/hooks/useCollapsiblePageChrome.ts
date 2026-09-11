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

// Short/empty pages still need enough native travel for one collapse and one
// reverse gesture. Because this minimum grows with the scroller, hiding the
// surrounding chrome cannot clamp scrollTop back to zero.
export const PAGE_CHROME_SCROLL_RUNWAY_PX = 64;
export const PAGE_CHROME_SCROLL_RUNWAY_CLASS = "min-h-[calc(100%_+_4rem)] lg:min-h-0";

const safeScrollTop = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

export const shouldKeepPageChromeExpanded = (activeElement: Element | null) =>
  activeElement instanceof HTMLElement
  && (
    activeElement.matches("input, textarea")
    || activeElement.isContentEditable
    || activeElement.getAttribute("contenteditable") === "true"
  );

const OPEN_CHROME_LAYER_SELECTOR = '[aria-expanded="true"], [data-state="open"], [role="dialog"]';

const chromeContainsFocusOrOpenLayer = (
  chromeElement: HTMLElement | null | undefined,
  activeElement: Element | null,
) => !!chromeElement
  && (
    chromeElement.contains(activeElement)
    || !!chromeElement.querySelector(OPEN_CHROME_LAYER_SELECTOR)
  );

export const shouldKeepFocusedChromeExpanded = (
  activeElement: Element | null,
  chromeElement: HTMLElement | null | undefined,
) => shouldKeepPageChromeExpanded(activeElement)
  || !!chromeElement?.querySelector(OPEN_CHROME_LAYER_SELECTOR)
  || (
    activeElement instanceof HTMLElement
    && !!chromeElement?.contains(activeElement)
    && activeElement.matches(":focus-visible")
  );

export const blurPointerFocusedChromeControl = (
  activeElement: Element | null,
  chromeElement: HTMLElement | null | undefined,
) => {
  if (
    !(activeElement instanceof HTMLElement)
    || !chromeElement?.contains(activeElement)
    || shouldKeepFocusedChromeExpanded(activeElement, chromeElement)
  ) return false;

  activeElement.blur();
  return true;
};

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
  /** Never hide a chrome subtree while it contains keyboard/focus state. */
  keepExpandedWithinRef?: RefObject<HTMLElement | null>;
  /** A second chrome subtree, such as the shared application header. */
  additionalKeepExpandedWithinRef?: RefObject<HTMLElement | null>;
  /** Synchronises route-owned chrome with the shared application shell. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Reinitialises both local and shared chrome when the route changes. */
  resetKey?: string;
}

export const useCollapsiblePageChrome = (
  scrollRef: RefObject<HTMLElement | null>,
  {
    additionalKeepExpandedWithinRef,
    collapseDistance = DEFAULT_PAGE_CHROME_SCROLL_OPTIONS.collapseDistance,
    keepExpandedWithinRef,
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

    const setChrome = (nextCollapsed: boolean) => {
      if (chromeIsCollapsed === nextCollapsed) return;
      if (nextCollapsed) {
        const activeElement = document.activeElement;
        const focusedChrome = [
          keepExpandedWithinRef?.current,
          additionalKeepExpandedWithinRef?.current,
        ].find((element) => chromeContainsFocusOrOpenLayer(element, activeElement));
        blurPointerFocusedChromeControl(activeElement, focusedChrome);
      }
      chromeIsCollapsed = nextCollapsed;
      setCollapsed(nextCollapsed);
      onCollapsedChange?.(nextCollapsed);
      tracker = createPageChromeScrollState(scroller.scrollTop, nextCollapsed);
    };

    const sampleScroll = () => {
      const scrollTop = safeScrollTop(scroller.scrollTop);

      if (!mediaQuery.matches) {
        setChrome(false);
        tracker = createPageChromeScrollState(scrollTop, false);
        return;
      }

      // Editors remain stable while typing. Other chrome controls veto hiding
      // only for keyboard-visible focus; a pointer/touch tap must not pin the
      // header open for the user's next swipe.
      const activeElement = document.activeElement;
      const focusedChrome = [
        keepExpandedWithinRef?.current,
        additionalKeepExpandedWithinRef?.current,
      ].find((element) => chromeContainsFocusOrOpenLayer(element, activeElement));
      if (shouldKeepFocusedChromeExpanded(activeElement, focusedChrome)) {
        setChrome(false);
        tracker = createPageChromeScrollState(scrollTop, false);
        return;
      }

      if (scrollTop <= resolvedOptions.revealAtTop) {
        setChrome(false);
        tracker = createPageChromeScrollState(scrollTop, false);
        return;
      }

      const next = advancePageChromeScroll(tracker, scrollTop, resolvedOptions);
      const changed = next.collapsed !== chromeIsCollapsed;
      tracker = next;
      if (changed) setChrome(next.collapsed);
    };

    const handleScroll = () => {
      // The work above is constant-time and only commits React state when a
      // threshold is crossed. Sampling the native event synchronously avoids
      // losing the final position when mobile browsers pause animation frames
      // during short momentum scrolls, tab transitions, or app switching.
      sampleScroll();
    };

    const handleMediaChange = () => {
      if (!mediaQuery.matches) setChrome(false);
      tracker = createPageChromeScrollState(scroller.scrollTop, mediaQuery.matches && chromeIsCollapsed);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });
    mediaQuery.addEventListener?.("change", handleMediaChange);
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      mediaQuery.removeEventListener?.("change", handleMediaChange);
      onCollapsedChange?.(false);
    };
  }, [
    additionalKeepExpandedWithinRef,
    collapseDistance,
    keepExpandedWithinRef,
    mediaQueryValue,
    onCollapsedChange,
    resetKey,
    revealAtTop,
    revealDistance,
    scrollRef,
  ]);

  return collapsed;
};
