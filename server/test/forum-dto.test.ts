import type { Post } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { buildForumPostDto } from "../src/services/forum.js";

const post = {
  id: "post-id", author_id: "author-id", content: "Private identity",
  community_id: "iit-community", scope_type: "GLOBAL", scope_key: "IIT_ALL",
  is_anonymous: true, file_size: 42n, created_at: new Date("2026-09-04T12:00:00.000Z"), updated_at: new Date("2026-09-04T12:00:00.000Z"),
} as unknown as Post;

describe("forum post DTO", () => {
  it("hides anonymous identity while retaining viewer ownership", () => {
    const publicDto = buildForumPostDto(post, "viewer-id", "member", { profile: { user_id: "author-id", name: "Hidden", avatar_url: null, slug: null } });
    expect(publicDto.author_id).toBeNull();
    expect(publicDto.profile).toBeNull();
    expect(publicDto.viewer_is_author).toBe(false);

    const ownerDto = buildForumPostDto(post, "author-id", "member");
    expect(ownerDto.author_id).toBe("author-id");
    expect(ownerDto.viewer_is_author).toBe(true);
    expect(ownerDto.profile).toBeNull();
  });

  it("adds safe aggregate and viewer fields and serializes bigint values", () => {
    const dto = buildForumPostDto({ ...post, is_anonymous: false } as Post, "viewer-id", "member", {
      profile: { user_id: "author-id", name: "Author", avatar_url: null, slug: "author" },
      poll: { id: "poll-id" }, replyCount: 3, reactions: { "👍": 2 }, myReactions: ["👍"], viewerHasPinned: true,
    });
    expect(dto).toMatchObject({ replyCount: 3, reactions: { "👍": 2 }, myReactions: ["👍"], viewer_has_pinned: true, file_size: "42" });
    expect(dto.profile).toMatchObject({ name: "Author" });
  });

  it("does not reveal the creator ID through an anonymous poll", () => {
    const dto = buildForumPostDto(post, "viewer-id", "member", {
      poll: { id: "poll-id", post_id: post.id, created_by: "author-id", question: "Private poll author" },
    });
    expect(dto.poll).toEqual({ id: "poll-id", post_id: post.id, question: "Private poll author" });
  });

  it("uses opaque attachment handles and neutral metadata for anonymous viewers", () => {
    const dto = buildForumPostDto({
      ...post,
      image_path: "author-id/private.webp",
      file_path: "author-id/Sunand-Garg-resume.pdf",
      file_name: "Sunand Garg resume.pdf",
      deleted_by_user_id: "author-id",
    } as Post, "viewer-id", "member", {
      mediaHandles: new Map([
        ["post-images/author-id/private.webp", "opaque/11111111-1111-4111-8111-111111111111"],
        ["forum-files/author-id/Sunand-Garg-resume.pdf", "opaque/22222222-2222-4222-8222-222222222222"],
      ]),
    });
    expect(dto).toMatchObject({
      author_id: null,
      deleted_by_user_id: null,
      client_id: null,
      image_path: "opaque/11111111-1111-4111-8111-111111111111",
      file_path: "opaque/22222222-2222-4222-8222-222222222222",
      file_name: "Attachment",
    });
    expect(JSON.stringify(dto)).not.toContain("author-id/");
    expect(JSON.stringify(dto)).not.toContain("Sunand Garg");
  });

  it("returns only tombstone metadata after delete-for-everyone", () => {
    const dto = buildForumPostDto({
      ...post, is_anonymous: false, is_deleted_for_everyone: true,
      image_path: "author-id/image.webp", file_path: "author-id/private.pdf", voice_path: "author-id/voice.webm",
    } as Post, "viewer-id", "member", {
      profile: { user_id: "author-id", name: "Author", avatar_url: null, slug: "author" },
      poll: { id: "poll-id", question: "private" }, replyCount: 2, reactions: { "👍": 4 }, myReactions: ["👍"],
    });

    expect(dto).toMatchObject({
      id: "post-id", content: "", image_path: null, file_path: null, voice_path: null,
      is_deleted_for_everyone: true, poll: null, reactions: {}, myReactions: [], replyCount: 2,
    });
    expect(dto.profile).toMatchObject({ name: "Author" });
  });
});
