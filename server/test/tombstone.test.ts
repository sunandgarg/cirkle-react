import { describe, expect, it } from "vitest";
import { contentTombstone, mediaReferencesRevoked, privateMediaObjectKeys } from "../src/security/tombstone.js";
import { queryReferencesDeletedContent, realtimeSafeCoreRow } from "../src/services/data.js";

describe("delete-for-everyone tombstones", () => {
  it("removes content and every private-media reference while retaining routing metadata", () => {
    const row = contentTombstone({
      id: "message-one", room_id: "room-one", sender_id: "member-one", content: "secret",
      image_path: "member-one/image.webp", media_url: "https://example.invalid/private",
      file_path: "member-one/file.pdf", file_name: "private.pdf", voice_path: "member-one/voice.webm",
      is_deleted_for_everyone: true, created_at: "2026-09-04T12:00:00.000Z",
    });

    expect(row).toMatchObject({
      id: "message-one", room_id: "room-one", sender_id: "member-one", content: "",
      image_path: null, media_url: null, file_path: null, file_name: null, voice_path: null,
      is_deleted_for_everyone: true, created_at: "2026-09-04T12:00:00.000Z",
    });
  });

  it("does not mutate or redact active content", () => {
    const original = { id: "post-one", content: "visible", image_path: "member/image.webp", is_deleted_for_everyone: false };
    const copy = contentTombstone(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
  });

  it("revokes a linked object only when every surviving reference is deleted", () => {
    expect(mediaReferencesRevoked([])).toBe(false);
    expect(mediaReferencesRevoked([{ is_deleted_for_everyone: true }, { deleted_at: "2026-09-04" }])).toBe(true);
    expect(mediaReferencesRevoked([{ is_deleted_for_everyone: true }, { is_deleted_for_everyone: false }])).toBe(false);
  });

  it("derives only the expected private bucket keys", () => {
    expect(privateMediaObjectKeys({ image_path: "u/image.webp", file_path: "u/file.pdf", voice_path: "u/voice.webm" }, "post"))
      .toEqual(["post-images/u/image.webp", "forum-files/u/file.pdf", "voice-notes/u/voice.webm"]);
    expect(privateMediaObjectKeys({ media_path: "u/image.webp", voice_path: "u/voice.webm" }, "message"))
      .toEqual(["chat-media/u/image.webp", "voice-notes/u/voice.webm"]);
    expect(privateMediaObjectKeys({ media_path: "u/legacy.webp", media_bucket: "post-images" }, "message"))
      .toEqual(["post-images/u/legacy.webp"]);
    expect(privateMediaObjectKeys({ image_path: "u/story.webp" }, "story")).toEqual(["stories/u/story.webp"]);
  });

  it("detects nested searches and ordering that could infer deleted content", () => {
    expect(queryReferencesDeletedContent({
      filters: [{ operator: "or", expression: "and(scope_type.eq.GLOBAL,content.ilike.%secret%)" }],
      order: [],
    })).toBe(true);
    expect(queryReferencesDeletedContent({ filters: [], order: [{ column: "file_name", ascending: true }] })).toBe(true);
    expect(queryReferencesDeletedContent({ filters: [{ column: "scope_type", operator: "eq", value: "GLOBAL" }], order: [] })).toBe(false);
  });

  it("never exposes an anonymous author in a shared realtime event", () => {
    expect(realtimeSafeCoreRow("posts", {
      id: "post-one", author_id: "owner-secret", deleted_by_user_id: "owner-secret", is_anonymous: true,
      content: "hello", image_path: "owner-secret/private.webp", file_name: "Real Name.pdf",
    })).toMatchObject({
      author_id: null, deleted_by_user_id: null, viewer_is_author: false, profile: null,
      image_path: null, file_name: null,
    });
  });
});
