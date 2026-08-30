import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ImageLightbox from "@/components/forum/ImageLightbox";

describe("forum image lightbox", () => {
  it("lets a mobile user zoom back to fit and close the preview", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="https://cdn.example.com/sample.gif" alt="Shared GIF" onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Shared GIF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();

    const image = screen.getByRole("img", { name: "Shared GIF" });
    fireEvent.click(image);
    expect(image).toHaveStyle({ transform: "scale(2)" });
    expect(screen.getByRole("button", { name: "Reset zoom" })).toBeInTheDocument();
    expect(screen.getByText("2× · tap image to fit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(image).toHaveStyle({ transform: "scale(1)" });
    expect(screen.queryByRole("button", { name: "Reset zoom" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="https://cdn.example.com/sample.webp" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
