import { act, render, screen } from "@testing-library/react";
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

const renderPage = (path: string, page: ReactNode, requestCollapsed = vi.fn()) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}>
      <PageChromeRequestProvider requestCollapsed={requestCollapsed} sharedTopChrome={sharedTopChrome}>
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

  it("keeps Consult in normal flow without scroll-driven geometry changes", () => {
    const requestCollapsed = vi.fn();
    renderPage("/consult", <Consult />, requestCollapsed);

    const owner = screen.getByTestId("consult-scroll-region");
    const chrome = screen.getByTestId("consult-scroll-chrome");
    expect(screen.getByTestId("shared-top-page-chrome").closest("[data-testid=consult-scroll-chrome]")).toBe(chrome);
    expect(chrome.closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(chrome).not.toHaveClass("sticky", "overflow-hidden", "transition-[max-height,opacity,transform]");
    expect(chrome).toHaveClass("[&_[role=banner]]:static");
    expect(chrome).not.toHaveAttribute("aria-hidden");
    const content = owner.querySelector<HTMLElement>(":scope > [data-page-scroll-content=true]");
    expect(content?.closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(content).not.toHaveClass("min-h-[calc(100%_+_4rem)]");
    expect(owner).toHaveClass("![overflow-anchor:auto]");

    const search = screen.getByPlaceholderText("Search by name, skill, or topic...");
    search.focus();
    act(() => {
      owner.scrollTop = 120;
      owner.dispatchEvent(new Event("scroll"));
    });
    expect(requestCollapsed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);
    expect(chrome).not.toHaveAttribute("inert");
    expect(screen.getByRole("heading", { name: "Consult" })).toBeInTheDocument();
  });

  it("keeps Jobs in normal flow without scroll-driven geometry changes", () => {
    const requestCollapsed = vi.fn();
    renderPage("/jobs", <Jobs />, requestCollapsed);

    const owner = screen.getByTestId("jobs-scroll-region");
    const chrome = screen.getByTestId("jobs-scroll-chrome");
    expect(screen.getByTestId("shared-top-page-chrome").closest("[data-testid=jobs-scroll-chrome]")).toBe(chrome);
    expect(chrome.closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(chrome).not.toHaveClass("sticky", "overflow-hidden", "transition-[max-height,opacity,transform,border-color]");
    expect(chrome).toHaveClass("[&_[role=banner]]:static");
    expect(chrome).not.toHaveAttribute("aria-hidden");
    const content = owner.querySelector<HTMLElement>(":scope > [data-page-scroll-content=true] > div");
    expect(content?.closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(content).not.toHaveClass("min-h-[calc(100%_+_4rem)]");
    expect(owner).toHaveClass("![overflow-anchor:auto]");

    const search = screen.getByPlaceholderText("Search role, company, skill, or location");
    search.focus();
    act(() => {
      owner.scrollTop = 120;
      owner.dispatchEvent(new Event("scroll"));
    });
    expect(requestCollapsed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);
    expect(chrome).not.toHaveAttribute("inert");
    expect(screen.getByRole("heading", { name: "Jobs" })).toBeInTheDocument();
  });
});
