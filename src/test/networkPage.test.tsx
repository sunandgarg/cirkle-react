import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Network from "@/pages/Network";

const mocks = vi.hoisted(() => ({
  queries: [] as Array<{
    table: string;
    equals: Array<[string, unknown]>;
    ilikes: Array<[string, unknown]>;
    range?: [number, number];
  }>,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "viewer-1" },
    isVerified: true,
    profile: { iit_name: "IIT Delhi", student_status: "Class of 2026" },
  }),
}));

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const query = { table, equals: [] as Array<[string, unknown]>, ilikes: [] as Array<[string, unknown]>, range: undefined as [number, number] | undefined };
    mocks.queries.push(query);
    const builder: any = {
      select: vi.fn(() => builder),
      neq: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => { query.equals.push([column, value]); return builder; }),
      ilike: vi.fn((column: string, value: unknown) => { query.ilikes.push([column, value]); return builder; }),
      in: vi.fn(() => builder),
      or: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn((from: number, to: number) => { query.range = [from, to]; return builder; }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(
        table === "profiles"
          ? { data: [{ user_id: `member-${query.range?.[0] ?? 0}`, name: "Member", iit_name: "IIT Delhi", student_status: "Class of 2026" }], count: 100, error: null }
          : { data: [], count: 0, error: null },
      ).then(resolve, reject),
    };
    return builder;
  };
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return { supabase: { from: vi.fn(from), channel: vi.fn(() => channel), removeChannel: vi.fn() } };
});

describe("network member discovery page", () => {
  beforeEach(() => {
    mocks.queries.length = 0;
  });

  it("opens the suggestions alias, applies IIT/year chips, and exposes the next server page", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/network/suggestions"]}>
          <Network />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const discoverTab = screen.getByRole("button", { name: "Discover" });
    expect(discoverTab).toHaveClass("bg-primary");
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "IIT Delhi" }));
    await waitFor(() => expect(mocks.queries.some((query) => query.equals.some(([column, value]) => column === "iit_name" && value === "IIT Delhi"))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Class of 2026" }));
    await waitFor(() => expect(mocks.queries.some((query) =>
      query.equals.some(([column]) => column === "iit_name")
      && query.ilikes.some(([column, value]) => column === "student_status" && value === "%2026%"),
    )).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocks.queries.some((query) => query.range?.[0] === 48 && query.range?.[1] === 95)).toBe(true));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
  });
});
