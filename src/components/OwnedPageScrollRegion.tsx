import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A route-owned native vertical scroller. Page chrome and page content must be
 * siblings inside this element so a gesture that begins on the title, search,
 * or filters continues on the same scroll axis as the result list.
 */
const OwnedPageScrollRegion = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-page-scroll-owner="true"
      className={cn(
        "h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain [overflow-anchor:none] [-webkit-overflow-scrolling:touch] [touch-action:auto]",
        className,
      )}
      {...props}
    />
  ),
);

OwnedPageScrollRegion.displayName = "OwnedPageScrollRegion";

export default OwnedPageScrollRegion;
