import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import CalendarPage from "@/pages/CalendarPage";
import type { Database } from "@/integrations/supabase/types";

type EventRow = Database["public"]["Tables"]["events"]["Row"];

const event = (id: string, startTime: string, sourceIit: string): EventRow => ({
  audience_mode: "everyone",
  community_id: "iit-community",
  created_at: "2026-08-01T00:00:00Z",
  created_by: "admin-1",
  description: null,
  end_time: null,
  id,
  location: "Main auditorium",
  organizer: null,
  published_at: "2026-08-01T00:00:00Z",
  registration_url: null,
  scan_run_id: null,
  source_fingerprint: null,
  source_iit: sourceIit,
  source_type: "manual",
  source_url: null,
  start_time: startTime,
  status: "published",
  target_courses: [],
  target_iits: [],
  target_specialisations: [],
  title: `${sourceIit} event ${id}`,
  updated_at: "2026-08-01T00:00:00Z",
});

const events = [
  event("delhi-23", "2026-09-23T04:30:00Z", "IIT Delhi"),
  event("bombay-02", "2026-09-02T04:30:00Z", "IIT Bombay"),
  event("madras-02", "2026-09-02T06:30:00Z", "IIT Madras"),
];

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "viewer-1" }, isAdmin: false, profile: { iit_name: "IIT Delhi" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const result = table === "events" ? { data: events, error: null } : { data: [], error: null };
      const builder: Record<string, unknown> & PromiseLike<typeof result> = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    }),
  },
}));

describe("Events calendar ordering", () => {
  const originalTimezone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });

  afterAll(() => {
    process.env.TZ = originalTimezone;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps IST month chips, day filtering, group headings, and cards in one chronology", async () => {
    // This instant is still August 31 in Los Angeles but September 1 in India.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T20:00:00Z"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/events"]}><CalendarPage /></MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: /showing September 2026/i })).toHaveTextContent("September 2026");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));

    const scrollOwner = screen.getByTestId("events-scroll-region");
    expect(screen.getByRole("heading", { name: "Events" }).closest("header")?.closest("[data-page-scroll-owner=true]")).toBe(scrollOwner);
    expect(scrollOwner.querySelector(":scope > [data-page-scroll-content=true]")).toBeTruthy();
    expect(screen.getAllByRole("article")[0].closest("[data-page-scroll-owner=true]")).toBe(scrollOwner);

    const orderedArticles = screen.getAllByRole("article");
    expect(orderedArticles.map((article) => within(article).getByRole("heading").textContent)).toEqual([
      "IIT Bombay event bombay-02",
      "IIT Madras event madras-02",
      "IIT Delhi event delhi-23",
    ]);
    expect(screen.getByRole("heading", { name: /Wednesday, 2 September/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Wednesday, 23 September/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Wednesday, 2 September, 2 events/i }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "IIT Delhi event delhi-23" })).not.toBeInTheDocument();
  });
});
