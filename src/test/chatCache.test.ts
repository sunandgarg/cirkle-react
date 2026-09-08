import { describe, expect, it } from "vitest";
import { boundedChatCacheMessages, scopedChatCacheKey } from "@/lib/chatCache";

describe("chat cache account isolation", () => {
  it("uses both the authenticated user and room identity", () => {
    expect(scopedChatCacheKey("member-a", "room-1")).toBe("member-a:room-1");
    expect(scopedChatCacheKey("member-a", "room-1")).not.toBe(scopedChatCacheKey("member-b", "room-1"));
  });

  it("keeps only the newest bounded room window for fast startup", () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({ id: `message-${index}` }));
    const cached = boundedChatCacheMessages(messages);

    expect(cached).toHaveLength(200);
    expect(cached[0].id).toBe("message-50");
    expect(cached.at(-1)?.id).toBe("message-249");
    expect(messages).toHaveLength(250);
  });
});
