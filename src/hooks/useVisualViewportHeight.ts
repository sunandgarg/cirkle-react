import { useEffect, useState } from "react";

export const resolveVisualViewportHeight = (
  visualViewportHeight?: number,
  windowInnerHeight?: number,
) => Math.max(1, Math.round(visualViewportHeight || windowInnerHeight || 1));

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
export const useVisualViewportHeight = () => {
  const readHeight = () => resolveVisualViewportHeight(
    typeof window !== "undefined" ? window.visualViewport?.height : undefined,
    typeof window !== "undefined" ? window.innerHeight : undefined,
  );

  const [height, setHeight] = useState(readHeight);

  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;

    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setHeight(readHeight()));
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

  return height;
};
