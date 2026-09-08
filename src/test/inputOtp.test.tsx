import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

describe("InputOTP mobile autofill contract", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses the platform one-time-code hint and a numeric keyboard by default", async () => {
    render(
      <InputOTP maxLength={6} aria-label="Verification code">
        <InputOTPGroup>
          {Array.from({ length: 6 }, (_, index) => <InputOTPSlot key={index} index={index} />)}
        </InputOTPGroup>
      </InputOTP>,
    );

    const input = screen.getByLabelText("Verification code");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("pattern", "^\\d+$");

    // input-otp schedules selection mirroring at 0/10/50 ms. Let those owned
    // callbacks settle while jsdom is still alive so a busy parallel suite
    // cannot report a false post-teardown React error.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  });
});
