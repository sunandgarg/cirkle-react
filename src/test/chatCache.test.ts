import { describe, expect, it } from "vitest";
import { scopedChatCacheKey } from "@/lib/chatCache";

describe("chat cache account isolation", () => {
  it("uses both the authenticated user and room identity", () => {
    expect(scopedChatCacheKey("member-a", "room-1")).toBe("member-a:room-1");
    expect(scopedChatCacheKey("member-a", "room-1")).not.toBe(scopedChatCacheKey("member-b", "room-1"));
  });
});
