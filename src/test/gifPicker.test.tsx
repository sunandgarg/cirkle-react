import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GifPicker from "@/components/GifPicker";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

const invoke = vi.mocked(supabase.functions.invoke);

describe("KLIPY GIF picker", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({
      data: {
        results: [{
          id: "welcome-1",
          slug: "welcome",
          title: "Welcome",
          url: "https://static.klipy.com/full.gif",
          preview: "https://static.klipy.com/preview.gif",
          width: 320,
          height: 240,
        }],
      },
      error: null,
    } as never);
  });

  it("uses KLIPY search and required provider attribution", async () => {
    render(<GifPicker onSelect={vi.fn()} onEmojiSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "GIFs" }));

    const search = await screen.findByPlaceholderText("Search KLIPY");
    expect(search).toBeInTheDocument();
    expect(search).toHaveClass("text-base");
    expect(screen.getByText("Powered by KLIPY")).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("klipy-search", {
      body: { q: "", type: "gifs", limit: 20 },
    }));
  });

  it("registers the share without delaying message selection", async () => {
    const onSelect = vi.fn();
    render(<GifPicker onSelect={onSelect} onEmojiSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "GIFs" }));
    fireEvent.click(await screen.findByRole("img", { name: "Welcome" }));

    expect(onSelect).toHaveBeenCalledWith("https://static.klipy.com/full.gif");
    expect(invoke).toHaveBeenCalledWith("klipy-search", {
      body: { action: "share", type: "gifs", slug: "welcome" },
    });
  });
});
