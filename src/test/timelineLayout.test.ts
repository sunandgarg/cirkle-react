import { describe, expect, it } from "vitest";
import {
  estimateDirectMessageRowHeight,
  estimateForumPostRowHeight,
  getTimelineScrollState,
  normalizeTimelineScrollOffset,
  TIMELINE_VIRTUALIZER_OPTIONS,
} from "@/lib/timelineLayout";

describe("timeline layout", () => {
  it("uses one end-anchored compositor path for prepends and live appends", () => {
    expect(TIMELINE_VIRTUALIZER_OPTIONS).toMatchObject({
      anchorTo: "end",
      followOnAppend: true,
      directDomUpdates: true,
      directDomUpdatesMode: "transform",
    });
  });

  it("reserves realistic space for rich Forum rows and bounds pathological text", () => {
    const plain = estimateForumPostRowHeight({ content: "Hello" });
    const image = estimateForumPostRowHeight({ content: "Photo", image_url: "https://example.test/image.webp" });
    const rich = estimateForumPostRowHeight({
      content: "Line\n".repeat(30),
      image_path: "post.webp",
      poll: { options: Array.from({ length: 20 }, (_, index) => `Option ${index}`) },
      reactions: { "👍": 2 },
      replyCount: 4,
    });

    expect(plain).toBe(68);
    expect(image).toBeGreaterThan(plain + 250);
    expect(rich).toBe(560);
  });

  it("accounts for direct-message media, wrapping, and replies", () => {
    expect(estimateDirectMessageRowHeight({ message_type: "image" })).toBe(276);
    expect(estimateDirectMessageRowHeight({ message_type: "voice" })).toBe(84);
    expect(estimateDirectMessageRowHeight({ content: "Short" })).toBe(66);
    expect(estimateDirectMessageRowHeight({ content: "x".repeat(200), reply_to_message_id: "parent" }))
      .toBeGreaterThan(150);
  });

  it("locks only empty timelines at their sole valid scroll offset", () => {
    expect(getTimelineScrollState(0)).toBe("empty");
    expect(normalizeTimelineScrollOffset(0, 42)).toBe(0);
    expect(normalizeTimelineScrollOffset(0, -18)).toBe(0);

    expect(getTimelineScrollState(1)).toBe("scrollable");
    expect(normalizeTimelineScrollOffset(1, 42)).toBe(42);
    expect(normalizeTimelineScrollOffset(200, 1_250)).toBe(1_250);
  });
});
