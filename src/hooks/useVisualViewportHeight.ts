import { useEffect, useState } from "react";

export const resolveVisualViewportHeight = (
  visualViewportHeight?: number,
  windowInnerHeight?: number,
) => Math.max(1, Math.round(visualViewportHeight || windowInnerHeight || 1));

export type VisualViewportFrame = { height: number; offsetTop: number };

export const resolveVisualViewportFrame = (
  visualViewportHeight?: number,
  windowInnerHeight?: number,
  visualViewportOffsetTop?: number,
): VisualViewportFrame => ({
  height: resolveVisualViewportHeight(visualViewportHeight, windowInnerHeight),
  offsetTop: Math.max(0, Math.round(visualViewportOffsetTop || 0)),
});

export const shouldAnchorLatestDuringKeyboard = (
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 160,
) => scrollHeight - scrollTop - clientHeight < threshold;

/**
 * `100dvh` is still reported against the layout viewport in some iOS browser
 * configurations while the software keyboard is open. The Visual Viewport API
 * tracks the part of the page the member can actually see, so chat controls can
 * remain immediately above the keyboard instead of underneath it.
 */
export const useVisualViewportFrame = () => {
  const readFrame = () => resolveVisualViewportFrame(
    typeof window !== "undefined" ? window.visualViewport?.height : undefined,
    typeof window !== "undefined" ? window.innerHeight : undefined,
    typeof window !== "undefined" ? window.visualViewport?.offsetTop : undefined,
  );

  const [frame, setFrame] = useState(readFrame);

  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;

    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setFrame((current) => {
        const next = readFrame();
        return current.height === next.height && current.offsetTop === next.offsetTop ? current : next;
      }));
    };

    update();
    window.addEventListener("resize", update, { passive: true });
    viewport?.addEventListener("resize", update, { passive: true });
    viewport?.addEventListener("scroll", update, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, []);

  return frame;
};

export const useVisualViewportHeight = () => useVisualViewportFrame().height;
