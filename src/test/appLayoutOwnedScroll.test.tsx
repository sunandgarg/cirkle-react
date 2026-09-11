import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AppLayout from "@/components/AppLayout";
import OwnedPageScrollRegion from "@/components/OwnedPageScrollRegion";
import { SharedTopPageChrome } from "@/contexts/PageChromeContext";

vi.mock("@/components/AppHeader", () => ({
  default: () => <header data-testid="app-header">Application header</header>,
}));
vi.mock("@/components/BottomNav", () => ({
  default: () => <nav data-testid="bottom-nav">Bottom navigation</nav>,
}));
vi.mock("@/components/DesktopSidebar", () => ({ default: () => null }));
vi.mock("@/components/LockedModeOverlay", () => ({ default: () => null }));
vi.mock("@/components/GlobalSearchOverlay", () => ({ default: () => null }));
vi.mock("@/components/ProfileCompletionBanner", () => ({ default: () => null }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    isVerified: false,
    profile: null,
    profileResolved: true,
    user: null,
  }),
}));
vi.mock("@/hooks/usePrefetch", () => ({ usePrefetch: vi.fn() }));
vi.mock("@/hooks/useVisualViewportHeight", () => ({
  useVisualViewportFrame: () => ({ height: 800, offsetTop: 0 }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(() => Promise.resolve({ error: null })) },
}));
vi.mock("@/lib/errorTelemetry", () => ({ reportError: vi.fn() }));

const OwnedRoute = ({ name }: { name: string }) => (
  <OwnedPageScrollRegion data-testid={`${name}-scroll-owner`}>
    <SharedTopPageChrome />
    <header data-testid={`${name}-local-header`}>{name} controls</header>
    <section data-testid={`${name}-results`}>{name} results</section>
  </OwnedPageScrollRegion>
);

const renderRoute = (path: string, name: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route element={<AppLayout />}>
        <Route path={path} element={<OwnedRoute name={name} />} />
      </Route>
    </Routes>
  </MemoryRouter>,
);

const BrokenOwnedRoute = (): never => {
  throw new Error("route render failed");
};

describe("AppLayout owned scroll routes", () => {
  it.each([
    ["/jobs", "jobs"],
    ["/consult", "consult"],
    ["/calendar", "events"],
  ])("puts every visible %s top hit zone in the route's sole native scroller", (path, name) => {
    renderRoute(path, name);

    const owner = screen.getByTestId(`${name}-scroll-owner`);
    expect(screen.getByTestId("app-header").closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(screen.getByTestId(`${name}-local-header`).closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(screen.getByTestId(`${name}-results`).closest("[data-page-scroll-owner=true]")).toBe(owner);
    expect(screen.getByTestId("bottom-nav").closest("[data-page-scroll-owner=true]")).toBeNull();
    expect(document.querySelectorAll("[data-page-scroll-owner=true]")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveClass("overflow-hidden");
  });

  it("keeps the shared header available when an owned route fails to render", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <MemoryRouter initialEntries={["/jobs"]}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/jobs" element={<BrokenOwnedRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );

      expect(screen.getByTestId("app-header")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
