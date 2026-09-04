import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NotificationBell from "@/components/NotificationBell";
import CallModal from "@/components/CallModal";

const roomId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const expiresAt = Date.parse("2999-09-04T10:05:00.000Z");

const mocks = vi.hoisted(() => ({
  notifications: [] as Array<Record<string, unknown>>,
  invoke: vi.fn(),
  createFrame: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "viewer-1" } }),
}));

vi.mock("@daily-co/daily-js", () => ({
  default: { createFrame: mocks.createFrame },
}));

vi.mock("@/integrations/supabase/client", () => {
  const query = () => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: vi.fn(chain),
      update: vi.fn(chain),
      insert: vi.fn(chain),
      eq: vi.fn(chain),
      is: vi.fn(chain),
      order: vi.fn(chain),
      limit: vi.fn(async () => ({ data: mocks.notifications, error: null })),
      single: vi.fn(async () => ({ data: null, error: null })),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, count: 1, error: null }).then(resolve),
    });
    return builder;
  };
  const realtimeChannel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  realtimeChannel.on.mockReturnValue(realtimeChannel);
  realtimeChannel.subscribe.mockReturnValue(realtimeChannel);
  return {
    supabase: {
      from: vi.fn(query),
      functions: { invoke: mocks.invoke },
      channel: vi.fn(() => realtimeChannel),
      removeChannel: vi.fn(),
    },
  };
});

const LocationProbe = () => {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
};

describe("recipient call flow", () => {
  beforeEach(() => {
    mocks.notifications = [];
    mocks.invoke.mockReset();
    mocks.createFrame.mockReset();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
    });
  });

  it("navigates a valid call notification without following its stored link", async () => {
    mocks.notifications = [{
      id: "notification-1",
      user_id: "viewer-1",
      title: "Priya is calling",
      message: "Incoming video call",
      type: "call_invite",
      is_read: true,
      room_id: roomId,
      call_session_id: sessionId,
      call_mode: "video",
      expires_at: new Date(expiresAt).toISOString(),
      created_at: "2026-09-04T10:00:00.000Z",
      link: "javascript:alert(1)",
    }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/network"]}>
          <NotificationBell />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    fireEvent.click(await screen.findByRole("button", { name: "Join call" }));
    expect(screen.getByLabelText("location")).toHaveTextContent(
      `/chats/${roomId}?call=video&session=${sessionId}&expires=${expiresAt}`,
    );
  });

  it("reuses the invited session when requesting the recipient token", async () => {
    const call = {
      on: vi.fn(),
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
      destroy: vi.fn(),
    };
    call.on.mockReturnValue(call);
    mocks.createFrame.mockReturnValue(call);
    mocks.invoke.mockResolvedValue({
      data: { url: "https://example.daily.co/cirkle-room", token: "daily-token", sessionId },
      error: null,
    });

    render(<CallModal roomId={roomId} mode="audio" sessionId={sessionId} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("daily-create-room", {
      body: { roomId, mode: "audio", sessionId },
    }));
    await waitFor(() => expect(call.join).toHaveBeenCalledWith({
      url: "https://example.daily.co/cirkle-room",
      token: "daily-token",
      startVideoOff: true,
    }));
  });
});
