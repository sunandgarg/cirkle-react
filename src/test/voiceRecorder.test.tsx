import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoiceRecorder from "@/components/forum/VoiceRecorder";

class FakeMediaRecorder {
  static isTypeSupported = (type: string) => type === "audio/mp4";
  state: RecordingState = "inactive";
  mimeType = "audio/mp4";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

class FakeFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL() {
    this.result = "data:audio/mp4;base64,dm9pY2U=";
    this.onload?.();
  }
}

describe("VoiceRecorder", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("records and sends a Safari-compatible local test voice note", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("FileReader", FakeFileReader);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:voice-preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<VoiceRecorder userId="test-user" localOnly onSend={onSend} onCancel={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(1100); });

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Send voice note" }));
    await act(async () => { await Promise.resolve(); });

    expect(onSend).toHaveBeenCalledWith("data:audio/mp4;base64,dm9pY2U=", 1);
  });
});
