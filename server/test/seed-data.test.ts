import { describe, expect, it } from "vitest";
import { buildTestSeedPosts, trackedTestSeedUserIds } from "../src/services/functions.js";

describe("development cohort seed", () => {
  it("creates the promised 24-member, 1,500-message threaded cohort dataset", () => {
    const users = Array.from({ length: 24 }, (_, index) => `member-${index + 1}`);
    const posts = buildTestSeedPosts(users, new Date("2026-09-04T12:00:00.000Z"));
    const parents = posts.filter((post) => !post.reply_to_id);
    const replies = posts.filter((post) => post.reply_to_id);

    expect(posts).toHaveLength(1_500);
    expect(parents).toHaveLength(1_200);
    expect(replies).toHaveLength(300);
    expect(new Set(parents.map((post) => post.id)).size).toBe(1_200);
    expect(replies.every((reply) => parents.some((parent) => parent.id === reply.reply_to_id))).toBe(true);
    expect(posts.every((post) => post.scope_type === "COHORT"
      && post.scope_key === "IIT_DELHI|MBA|GENERAL|2026"
      && users.includes(String(post.author_id)))).toBe(true);
  });

  it("refuses a partial member cohort instead of silently producing skewed data", () => {
    expect(() => buildTestSeedPosts(["only-one-member"])).toThrow(/exactly 24/);
  });

  it("purges only UUIDs explicitly tracked by the seed manifest", () => {
    expect(trackedTestSeedUserIds([
      { data: { key: "test_seed_user_ids", value: JSON.stringify([
        "11111111-1111-4111-8111-111111111111",
        "not-a-user-id",
      ]) } },
      { data: { key: "unrelated", value: JSON.stringify(["22222222-2222-4222-8222-222222222222"]) } },
    ] as any)).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});
