import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import {
  getForumTimelineScrollState,
  normalizeForumTimelineScrollOffset,
  type ForumTimelineScrollState,
} from "@/lib/timelineLayout";

/**
 * Measures the Forum viewport rather than inferring overflow from message
 * count. This keeps empty and short rooms static while preserving fully native
 * momentum scrolling as soon as the rendered timeline exceeds its viewport.
 */
export const useForumTimelineScrollState = (
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  contentVersion: unknown,
): ForumTimelineScrollState => {
  const [state, setState] = useState<ForumTimelineScrollState>("static");

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const next = getForumTimelineScrollState(scroller.scrollHeight, scroller.clientHeight);
    const normalizedOffset = normalizeForumTimelineScrollOffset(next, scroller.scrollTop);
    if (normalizedOffset !== scroller.scrollTop) scroller.scrollTop = normalizedOffset;
    setState((current) => current === next ? current : next);
  }, [scrollRef]);

  useLayoutEffect(() => {
    measure();

    const scroller = scrollRef.current;
    const content = contentRef.current;
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    if (scroller) observer?.observe(scroller);
    if (content) observer?.observe(content);

    window.addEventListener("resize", measure, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [contentRef, measure, scrollRef]);

  useLayoutEffect(() => {
    // React commits and virtualizer measurements do not necessarily happen in
    // the same frame. Recheck once after semantic timeline changes; subsequent
    // image/row resizing is covered by ResizeObserver.
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [contentVersion, measure]);

  return state;
};
