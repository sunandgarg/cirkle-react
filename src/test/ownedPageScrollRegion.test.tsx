import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import OwnedPageScrollRegion from "@/components/OwnedPageScrollRegion";
import {
  isOwnedPageScrollRoute,
  PageChromeRequestProvider,
  SharedTopPageChrome,
} from "@/contexts/PageChromeContext";
import Consult from "@/pages/Consult";
import Jobs from "@/pages/Jobs";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: null, profile: null }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => {
      const result = { data: [], error: null };
      const builder: Record<string, unknown> & PromiseLike<typeof result> = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        or: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    }),
  },
}));

const sharedTopChrome = <div data-testid="shared-top-page-chrome">Global navigation</div>;

const renderPage = (path: string, page: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}>
      <PageChromeRequestProvider requestCollapsed={vi.fn()} sharedTopChrome={sharedTopChrome}>
        {page}
      </PageChromeRequestProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe("route-owned page scrolling", () => {
  it("keeps top chrome and list content on the same native scroll surface", () => {
    render(
      <PageChromeRequestProvider requestCollapsed={vi.fn()} sharedTopChrome={sharedTopChrome}>
        <OwnedPageScrollRegion data-testid="scroll-owner">
          <SharedTopPageChrome />
          <header data-testid="top-chrome"><input aria-label="Search" /></header>
          <main data-testid="results">Results</main>
        </OwnedPageScrollRegion>
      </PageChromeRequestProvider>,
    );

    const owner = screen.getByTestId("scroll-owner");
    expect(screen.getByTestId("shared-top-page-chrome").closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(screen.getByTestId("top-chrome").closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(screen.getByTestId("results").closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(owner.querySelectorAll("[data-page-scroll-owner=true]")).toHaveLength(0);
    expect(owner.firstElementChild).toBe(screen.getByTestId("shared-top-page-chrome"));
    expect(owner).toHaveClass(
      "overflow-y-auto",
      "overscroll-y-contain",
      "[overflow-anchor:none]",
      "[touch-action:auto]",
    );
  });

  it("prevents AppLayout from wrapping owned pages in another scroller", () => {
    expect(isOwnedPageScrollRoute("/consult")).toBe(true);
    expect(isOwnedPageScrollRoute("/consult/bookings")).toBe(true);
    expect(isOwnedPageScrollRoute("/jobs/remote")).toBe(true);
    expect(isOwnedPageScrollRoute("/calendar")).toBe(true);
    expect(isOwnedPageScrollRoute("/cirkle-forum")).toBe(false);
    expect(isOwnedPageScrollRoute("/chats/room-1")).toBe(false);
  });

  it("keeps the Consult controls and results in its route-owned scroller", () => {
    renderPage("/consult", <Consult />);

    const owner = screen.getByTestId("consult-scroll-region");
    const chrome = screen.getByTestId("consult-scroll-chrome");
    expect(screen.getByTestId("shared-top-page-chrome").closest("[data-testid=consult-scroll-chrome]")).toBe(chrome);
    expect(chrome.closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(chrome).toHaveClass("sticky", "top-0");
    expect(owner.querySelector(":scope > [data-page-scroll-content=true]")?.closest("[data-page-scroll-owner=true]")).toBe(owner);
  });

  it("keeps the Jobs controls and results in its route-owned scroller", () => {
    renderPage("/jobs", <Jobs />);

    const owner = screen.getByTestId("jobs-scroll-region");
    const chrome = screen.getByTestId("jobs-scroll-chrome");
    expect(screen.getByTestId("shared-top-page-chrome").closest("[data-testid=jobs-scroll-chrome]")).toBe(chrome);
    expect(chrome.closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(chrome).toHaveClass("sticky", "top-0");
    expect(owner.querySelector(":scope > [data-page-scroll-content=true]")?.closest("[data-page-scroll-owner=true]")).toBe(owner);
  });
});
