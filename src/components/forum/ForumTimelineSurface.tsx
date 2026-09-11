import type {
  PointerEventHandler,
  ReactNode,
  RefObject,
  UIEventHandler,
} from "react";
import type { ForumTimelineScrollState } from "@/lib/timelineLayout";

type ForumTimelineSurfaceProps = {
  scrollRef: RefObject<HTMLDivElement | null>;
  chromeRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  scrollState: ForumTimelineScrollState;
  chrome: ReactNode;
  children: ReactNode;
  onScroll: UIEventHandler<HTMLDivElement>;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
};

/**
 * The room chrome is sticky, but remains inside the timeline's native scroll
 * owner. A wheel or touch gesture that begins over the header therefore uses
 * the same compositor-driven scroll path as a gesture over a message.
 */
const ForumTimelineSurface = ({
  scrollRef,
  chromeRef,
  contentRef,
  scrollState,
  chrome,
  children,
  onScroll,
  onPointerDown,
}: ForumTimelineSurfaceProps) => (
  <div
    ref={scrollRef}
    data-scroll-state={scrollState}
    data-testid="forum-scroll-region"
    onScroll={onScroll}
    className="forum-chat-wallpaper forum-scroll-region flex-1"
  >
    <div ref={chromeRef} data-testid="forum-scroll-chrome" className="sticky top-0 z-20">
      {chrome}
    </div>
    <div
      ref={contentRef}
      data-testid="forum-scroll-content"
      onPointerDown={onPointerDown}
      className="mx-auto w-full max-w-5xl px-0"
    >
      {children}
    </div>
  </div>
);

export default ForumTimelineSurface;
