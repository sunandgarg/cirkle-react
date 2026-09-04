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
    ins: Array<[string, readonly unknown[]]>;
    ors: string[];
    range?: [number, number];
  }>,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "viewer-1" },
    isVerified: true,
    profile: { iit_name: "IIT Delhi", student_status: "current_student", primary_education_id: "education-viewer" },
  }),
}));

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const query = {
      table,
      equals: [] as Array<[string, unknown]>,
      ilikes: [] as Array<[string, unknown]>,
      ins: [] as Array<[string, readonly unknown[]]>,
      ors: [] as string[],
      range: undefined as [number, number] | undefined,
    };
    mocks.queries.push(query);
    const result = () => {
      if (table === "education") {
        if (query.equals.some(([column]) => column === "id")) {
          return { data: { id: "education-viewer", user_id: "viewer-1", institution: "IIT Delhi", passing_year: "2026", is_verified: true }, count: 1, error: null };
        }
        return { data: [{ user_id: "member-0" }, { user_id: "member-48" }], count: 2, error: null };
      }
      if (table === "profiles") {
        return { data: [{ user_id: `member-${query.range?.[0] ?? 0}`, name: "Member", iit_name: "IIT Delhi", student_status: "current_student", is_verified: true }], count: 100, error: null };
      }
      return { data: [], count: 0, error: null };
    };
    const builder: any = {
      select: vi.fn(() => builder),
      neq: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => { query.equals.push([column, value]); return builder; }),
      ilike: vi.fn((column: string, value: unknown) => { query.ilikes.push([column, value]); return builder; }),
      in: vi.fn((column: string, values: readonly unknown[]) => { query.ins.push([column, values]); return builder; }),
      or: vi.fn((expression: string) => { query.ors.push(expression); return builder; }),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      range: vi.fn((from: number, to: number) => { query.range = [from, to]; return builder; }),
      maybeSingle: vi.fn(async () => result()),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
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

    fireEvent.click(await screen.findByRole("button", { name: "Class of 2026" }));
    await waitFor(() => expect(mocks.queries.some((query) =>
      query.table === "education"
      && query.equals.some(([column, value]) => column === "passing_year" && value === "2026")
      && query.equals.some(([column, value]) => column === "institution" && value === "IIT Delhi"),
    )).toBe(true));
    await waitFor(() => expect(mocks.queries.some((query) => query.table === "profiles" && query.ins.some(([column]) => column === "user_id"))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocks.queries.some((query) => query.range?.[0] === 48 && query.range?.[1] === 95)).toBe(true));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
  }, 15_000);

  it("searches a bounded server page instead of downloading the member corpus", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/network"]}><Network /></MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search members" }), { target: { value: "Priya product" } });
    await waitFor(() => expect(mocks.queries.some((query) =>
      query.table === "profiles" && query.ors.length === 2 && query.range?.[0] === 0 && query.range?.[1] === 47,
    )).toBe(true));
    expect(mocks.queries.every((query) => !query.range || query.range[1] - query.range[0] < 250)).toBe(true);
  });
});
