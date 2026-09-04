import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DirectMessageSidebar from "@/components/forum/DirectMessageSidebar";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "viewer-1" } }),
}));

vi.mock("@/hooks/useRealtimeActivity", () => ({
  useRealtimeActivity: () => false,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: mocks.rpc,
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

describe("forum direct-message sidebar", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "get_direct_message_sidebar") return {
        data: [{
          connection_id: "connection-1", peer_id: "peer-1", room_id: "room-1",
          display_name: "Rahul", display_avatar: null, last_message: {
            content: "See you there", created_at: "2026-09-02T10:00:00.000Z", message_type: "text",
          }, unread_count: 1,
        }, {
          connection_id: "connection-2", peer_id: "peer-2", room_id: null,
          display_name: "Not started", display_avatar: null, last_message: null, unread_count: 0,
        }],
        error: null,
      };
      if (name === "search_my_connections") return {
        data: [{ peer_id: "peer-2", room_id: null, display_name: "Priya", display_avatar: null, headline: "Product manager" }],
        error: null,
      };
      return { data: null, error: null };
    });
  });

  it("keeps only started threads in the scroll region and searches connections in place", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <div className="flex h-[700px] w-[300px] flex-col">
            <DirectMessageSidebar />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Rahul")).toBeInTheDocument();
    expect(screen.queryByText("Not started")).not.toBeInTheDocument();
    expect(screen.getByTestId("direct-message-scroll-region")).toHaveClass("flex-1", "min-h-0");
    expect(screen.queryByText(/connect with a member/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start a direct message/i })).not.toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: /search your connections/i });
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "Pri" } });
    expect(await screen.findByText("Priya")).toBeInTheDocument();
    expect(screen.getByText("Product manager")).toBeInTheDocument();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith("search_my_connections", { p_query: "Pri", p_limit: 8 }));
  }, 15_000);

  it("keeps the channel panel usable when direct-message RPCs are temporarily unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("Failed to fetch") });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><DirectMessageSidebar /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("No private chats yet")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /search your connections/i })).toBeEnabled();
  });
});
