import { render, screen } from "@testing-library/react";
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

  it("uses the platform one-time-code hint and a numeric keyboard by default", () => {
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
  });
});
