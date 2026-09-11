import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ForumTimelineSurface from "@/components/forum/ForumTimelineSurface";

describe("Forum timeline native scroll surface", () => {
  it("keeps fixed-looking room chrome inside the same native gesture path as messages", () => {
    const scrollRef = createRef<HTMLDivElement>();
    const chromeRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();
    const onPointerDown = vi.fn();

    const { rerender } = render(
      <ForumTimelineSurface
        scrollRef={scrollRef}
        chromeRef={chromeRef}
        contentRef={contentRef}
        scrollState="static"
        onScroll={vi.fn()}
        onPointerDown={onPointerDown}
        chrome={<button type="button">Room header</button>}
      >
        <div>Short room</div>
      </ForumTimelineSurface>,
    );

    const scroller = screen.getByTestId("forum-scroll-region");
    const chrome = screen.getByTestId("forum-scroll-chrome");
    const content = screen.getByTestId("forum-scroll-content");
    expect(scrollRef.current).toBe(scroller);
    expect(chromeRef.current).toBe(chrome);
    expect(contentRef.current).toBe(content);
    expect(scroller).toContainElement(chrome);
    expect(scroller).toContainElement(content);
    expect(chrome).toHaveClass("sticky", "top-0");
    expect(scroller).toHaveClass("forum-scroll-region");
    expect(scroller).toHaveAttribute("data-scroll-state", "static");

    // Wheel input starts on the header but its event path still reaches the
    // native scroll owner. No synthetic delta forwarding exists.
    const wheelAtOwner = vi.fn();
    scroller.addEventListener("wheel", wheelAtOwner);
    fireEvent.wheel(screen.getByRole("button", { name: "Room header" }), { deltaY: 120 });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Room header" }), {
      pointerType: "touch",
      pointerId: 1,
    });
    expect(wheelAtOwner).toHaveBeenCalledOnce();
    // Header/search controls must not be blurred by the message-surface
    // keyboard dismissal handler.
    expect(onPointerDown).not.toHaveBeenCalled();

    fireEvent.pointerDown(content, { pointerType: "touch", pointerId: 2 });
    expect(onPointerDown).toHaveBeenCalledOnce();

    rerender(
      <ForumTimelineSurface
        scrollRef={scrollRef}
        chromeRef={chromeRef}
        contentRef={contentRef}
        scrollState="scrollable"
        onScroll={vi.fn()}
        onPointerDown={onPointerDown}
        chrome={<button type="button">Room header</button>}
      >
        <div>Overflowing room</div>
      </ForumTimelineSurface>,
    );
    expect(screen.getByTestId("forum-scroll-region")).toHaveAttribute("data-scroll-state", "scrollable");
    expect(scrollRef.current).toBe(scroller);
  });
});
