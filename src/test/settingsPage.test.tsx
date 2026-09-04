import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "@/pages/Settings";

const mocks = vi.hoisted(() => ({
  updateUser: vi.fn(),
  signOut: vi.fn(),
  clearChatCache: vi.fn(),
  clearForumHistoryCache: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "viewer-1", email: "member@iitd.ac.in" }, profile: { role: "user" } }),
}));

vi.mock("@/lib/chatCache", () => ({ clearChatCache: mocks.clearChatCache }));
vi.mock("@/lib/forumHistoryCache", () => ({ clearForumHistoryCache: mocks.clearForumHistoryCache }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { updateUser: mocks.updateUser, signOut: mocks.signOut },
    from: vi.fn(() => {
      const builder: any = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: vi.fn(chain),
        eq: vi.fn(chain),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      });
      return builder;
    }),
  },
}));

const LocationProbe = () => {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
};

const renderSettings = (path: string) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<><Settings /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe("settings pages", () => {
  beforeEach(() => {
    mocks.updateUser.mockReset().mockResolvedValue({ data: { user: { id: "viewer-1" } }, error: null });
    mocks.signOut.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.clearChatCache.mockReset().mockResolvedValue(undefined);
    mocks.clearForumHistoryCache.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
  });

  it("exposes named theme controls and a working password update", async () => {
    renderSettings("/settings/account");
    expect(screen.getByText("member@iitd.ac.in")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "securepass123" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "securepass123" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));

    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith({ password: "securepass123" }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/auth?password_reset=success"));
  }, 15_000);

  it("clears local application caches without signing the user out", async () => {
    localStorage.setItem("forum_v2_draft_viewer-1_GLOBAL_IIT_ALL", "draft");
    renderSettings("/settings/privacy");
    fireEvent.click(screen.getByRole("button", { name: "Clear cached data" }));

    await waitFor(() => expect(mocks.clearChatCache).toHaveBeenCalledOnce());
    expect(mocks.clearForumHistoryCache).toHaveBeenCalledOnce();
    expect(localStorage.getItem("forum_v2_draft_viewer-1_GLOBAL_IIT_ALL")).toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
