import { describe, expect, it } from "vitest";
import { assertUploadOverwriteAllowed, isOwnedReadyFile, messageReferencesObject, publicStorageObjectUrl, storyIsActive, verificationEvidenceIsLocked } from "../src/services/storage.js";

describe("friends-only story lifetime", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");

  it("allows only non-deleted stories whose expiry is in the future", () => {
    expect(storyIsActive({ expires_at: "2026-09-04T12:00:01.000Z", deleted_at: null }, now)).toBe(true);
    expect(storyIsActive({ expires_at: "2026-09-04T11:59:59.000Z", deleted_at: null }, now)).toBe(false);
    expect(storyIsActive({ expires_at: "2026-09-04T12:00:01.000Z", deleted_at: "2026-09-04T11:00:00.000Z" }, now)).toBe(false);
    expect(storyIsActive({ expires_at: "invalid", deleted_at: null }, now)).toBe(false);
  });

  it("rejects forged, deleted, and unfinished upload references", () => {
    const ready = { uploaded_by: "member-one", status: "ready", deleted_at: null };
    expect(isOwnedReadyFile(ready, "member-one")).toBe(true);
    expect(isOwnedReadyFile(ready, "attacker")).toBe(false);
    expect(isOwnedReadyFile({ ...ready, status: "uploading" }, "member-one")).toBe(false);
    expect(isOwnedReadyFile({ ...ready, deleted_at: new Date() }, "member-one")).toBe(false);
  });

  it("matches chat attachments to their exact storage bucket", () => {
    const legacy = { media_path: "member/image.webp", media_bucket: "post-images" };
    expect(messageReferencesObject(legacy, "post-images", "member/image.webp")).toBe(true);
    expect(messageReferencesObject(legacy, "chat-media", "member/image.webp")).toBe(false);
    expect(messageReferencesObject({ ...legacy, media_bucket: "chat-media" }, "chat-media", "member/image.webp")).toBe(true);
    expect(messageReferencesObject({ voice_path: "member/voice.webm" }, "voice-notes", "member/voice.webm")).toBe(true);
  });

  it("never permits verification evidence to be overwritten in place", () => {
    expect(() => assertUploadOverwriteAllowed("verification-documents", true)).toThrow(/cannot be overwritten/);
    expect(() => assertUploadOverwriteAllowed("verification-documents", false)).not.toThrow();
    expect(() => assertUploadOverwriteAllowed("post-images", true)).not.toThrow();
  });

  it("locks verification evidence while it is pending or approved", () => {
    expect(verificationEvidenceIsLocked({ document_path: "member/doc.pdf", status: "pending" }, "member/doc.pdf")).toBe(true);
    expect(verificationEvidenceIsLocked({ document_path: "member/doc.pdf", status: "approved" }, "member/doc.pdf")).toBe(true);
    expect(verificationEvidenceIsLocked({ document_path: "member/doc.pdf", status: "rejected" }, "member/doc.pdf")).toBe(false);
    expect(verificationEvidenceIsLocked({ document_path: "member/doc.pdf", status: "withdrawn" }, "member/doc.pdf")).toBe(false);
    expect(verificationEvidenceIsLocked({ document_path: "member/other.pdf", status: "approved" }, "member/doc.pdf")).toBe(false);
  });

  it("builds the canonical public URL used to lock submitted company logos", () => {
    expect(publicStorageObjectUrl("entity-logos", "member one/logo 1.webp"))
      .toContain("/api/storage/public/entity-logos/member%20one/logo%201.webp");
  });
});
