import { describe, expect, it, vi } from "vitest";
import { createRealtimeFallbackSlot, selectChatTypingChannel } from "@/lib/realtimeFallback";

describe("realtime fallback retirement", () => {
  it("retires synchronously and ignores late lifecycle callbacks", () => {
    const remove = vi.fn(async () => undefined);
    const slot = createRealtimeFallbackSlot(remove);
    const first = { name: "first" };

    expect(slot.attach(first)).toBe(true);
    expect(slot.markHealthy(first)).toBe(true);
    expect(slot.isHealthy()).toBe(true);
    expect(slot.retire()).toBe(true);
    expect(slot.hasChannel()).toBe(false);
    expect(slot.isHealthy()).toBe(false);
    expect(slot.markHealthy(first)).toBe(false);
    expect(remove).toHaveBeenCalledExactlyOnceWith(first);

    const replacement = { name: "replacement" };
    expect(slot.attach(replacement)).toBe(true);
    expect(slot.isCurrent(replacement)).toBe(true);
  });

  it("does not double-remove or replace an active fallback", () => {
    const remove = vi.fn();
    const slot = createRealtimeFallbackSlot(remove);
    const first = { name: "first" };

    expect(slot.attach(first)).toBe(true);
    expect(slot.attach({ name: "duplicate" })).toBe(false);
    expect(slot.retire()).toBe(true);
    expect(slot.retire()).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("chat typing transport selection", () => {
  const dedicated = { topic: "chat:room-one" };
  const fallback = { topic: "room-room-one" };

  it("keeps AppSync-mode typing on the dedicated chat channel during message fallback", () => {
    expect(selectChatTypingChannel(true, dedicated, fallback)).toBe(dedicated);
    expect(selectChatTypingChannel(true, null, fallback)).toBeNull();
  });

  it("preserves the combined Socket-only fallback behavior", () => {
    expect(selectChatTypingChannel(false, dedicated, fallback)).toBe(fallback);
    expect(selectChatTypingChannel(false, dedicated, null)).toBe(dedicated);
  });
});
