import { describe, expect, it } from "vitest";
import { COMMUNITY_IMAGE_TARGET_BYTES, nextCommunityImageCompression } from "@/lib/imageUtils";

describe("community image compression budget", () => {
  it("targets a 0.5 MiB maximum for ordinary community images", () => {
    expect(COMMUNITY_IMAGE_TARGET_BYTES).toBe(512 * 1024);
  });

  it("reduces encoder quality before reducing image dimensions", () => {
    expect(nextCommunityImageCompression(1600, 900, 0.75)).toEqual({ width: 1600, height: 900, quality: 0.67 });
    expect(nextCommunityImageCompression(1600, 900, 0.5)).toEqual({ width: 1360, height: 765, quality: 0.5 });
  });
});
