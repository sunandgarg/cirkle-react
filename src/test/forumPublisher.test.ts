import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForumOutboxItem } from "@/lib/forumOutbox";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => ({ upsert: mocks.upsert }),
  },
}));

vi.mock("@/lib/forumMedia", () => ({
  createForumMediaSignedUrl: vi.fn(),
}));

import { publishForumOutboxItem } from "@/lib/forumPublisher";

const pollItem = (): ForumOutboxItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  scopeType: "COHORT",
  scopeKey: "IIT_DELHI|MBA|GENERAL|2026",
  content: "",
  isAnonymous: false,
  replyToId: null,
  pollQuestion: "Where should we meet?",
  pollOptions: [" Library ", "Cafe"],
  createdAt: "2026-08-31T00:00:00.000Z",
  attempts: 0,
  nextAttemptAt: 0,
});

describe("forum publisher polls", () => {
  beforeEach(() => {
    mocks.rpc.mockReset().mockResolvedValue({ data: { id: pollItem().id }, error: null });
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
  });

  it("persists a poll-only post with a valid non-empty body before saving options", async () => {
    await publishForumOutboxItem(pollItem());

    expect(mocks.rpc).toHaveBeenCalledWith("create_forum_post", expect.objectContaining({
      p_content: "📊 Where should we meet?",
    }));
    expect(mocks.upsert).toHaveBeenCalledWith({
      post_id: pollItem().id,
      question: "Where should we meet?",
      options: ["Library", "Cafe"],
    }, { onConflict: "post_id" });
  });
});
