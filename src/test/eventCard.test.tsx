import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventCard } from "@/pages/CalendarPage";

type CardEvent = React.ComponentProps<typeof EventCard>["event"];

const event: CardEvent = {
  audience_mode: "everyone",
  community_id: "iit-community",
  created_at: "2026-09-01T00:00:00Z",
  created_by: "admin-1",
  description: "Meet researchers and explore current quantum-computing work.",
  end_time: "2026-09-02T12:00:00Z",
  id: "event-1",
  location: "Seminar Hall",
  organizer: "Department of Physics",
  published_at: "2026-09-01T00:00:00Z",
  registration_url: "https://events.example.edu/register",
  scan_run_id: null,
  source_fingerprint: null,
  source_iit: "IIT Delhi",
  source_type: "manual",
  source_url: null,
  start_time: "2026-09-02T10:00:00Z",
  status: "published",
  target_courses: [],
  target_iits: [],
  target_specialisations: [],
  title: "Quantum Research Symposium",
  updated_at: "2026-09-01T00:00:00Z",
};

describe("event card hierarchy and accessibility", () => {
  it("announces and renders the hosting campus before event details", () => {
    render(<EventCard event={event} onRespond={vi.fn()} />);

    const article = screen.getByRole("article", { name: /IIT Delhi Quantum Research Symposium/i });
    const campus = within(article).getByText("IIT Delhi");
    const title = within(article).getByRole("heading", { name: "Quantum Research Symposium" });
    expect(campus.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(article).getByText("Hosting campus")).toBeInTheDocument();
    expect(within(article).getByText("Campus event")).toBeInTheDocument();
    expect(within(article).getByText("All IITians")).toBeInTheDocument();
    expect(within(article).getByRole("link", { name: /Register for Quantum Research Symposium \(opens in a new tab\)/i })).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(article).getByRole("button", { name: "Mark as going for Quantum Research Symposium" })).toBeInTheDocument();
  });

  it("labels a missing source campus honestly as cross-IIT", () => {
    render(<EventCard event={{ ...event, id: "event-2", source_iit: null, registration_url: null }} onRespond={vi.fn()} />);
    const article = screen.getByRole("article", { name: /Cross-IIT \/ National Quantum Research Symposium/i });
    expect(within(article).getByText("All-IIT event")).toBeInTheDocument();
    expect(within(article).getByRole("button", { name: "Mark as not interested in Quantum Research Symposium" })).toBeInTheDocument();
  });
});
