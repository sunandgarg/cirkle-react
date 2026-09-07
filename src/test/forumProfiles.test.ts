import { describe, expect, it } from "vitest";
import { forumPostProfileSignature, resolveForumPostProfile } from "@/lib/forumProfiles";

describe("Forum author identity hydration", () => {
  const roomProfiles = new Map([
    ["author-1", {
      user_id: "author-1",
      name: "Sunand Garg",
      avatar_url: "https://cdn.example/avatar.webp",
      slug: "sunand-garg",
    }],
  ]);

  it("replaces a cached missing profile with the authorized room profile", () => {
    expect(resolveForumPostProfile({ author_id: "author-1", profile: null }, roomProfiles)).toEqual({
      user_id: "author-1",
      name: "Sunand Garg",
      avatar_url: "https://cdn.example/avatar.webp",
      slug: "sunand-garg",
    });
  });

  it("fills incomplete API identity fields without overwriting current values", () => {
    expect(resolveForumPostProfile({
      author_id: "author-1",
      profile: { user_id: "author-1", name: "Current Name", avatar_url: null, slug: null },
    }, roomProfiles)).toMatchObject({
      name: "Current Name",
      avatar_url: "https://cdn.example/avatar.webp",
      slug: "sunand-garg",
    });
  });

  it("never reveals a profile for an anonymous message", () => {
    expect(resolveForumPostProfile({ author_id: "author-1", is_anonymous: true, profile: null }, roomProfiles)).toBeNull();
  });

  it("changes the memo signature when the delayed profile arrives", () => {
    const post = { author_id: "author-1", profile: null };
    expect(forumPostProfileSignature(post, new Map())).toBe("");
    expect(forumPostProfileSignature(post, roomProfiles)).toContain("Sunand Garg");
  });
});
