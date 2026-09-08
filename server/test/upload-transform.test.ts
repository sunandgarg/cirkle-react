import { describe, expect, it } from "vitest";
import type { Express } from "express";
import { assertUncompressedUploadAllowed, normalizeUpload, STORED_UPLOAD_LIMIT_BYTES } from "../src/services/uploadTransform.js";

const upload = (buffer: Buffer, mimetype: string, originalname: string): Express.Multer.File => ({
  fieldname: "file",
  originalname,
  encoding: "7bit",
  mimetype,
  size: buffer.length,
  destination: "",
  filename: originalname,
  path: "",
  buffer,
  stream: null as never,
});

describe("upload normalization", () => {
  it("allows a 1 MiB source image so it can be compressed", () => {
    expect(() => assertUncompressedUploadAllowed({ mimetype: "image/jpeg", size: 1024 * 1024 })).not.toThrow();
  });

  it("converts a valid image to WebP below the stored 0.5 MiB cap", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#2864c7"/></svg>');
    const normalized = await normalizeUpload(upload(svg, "image/svg+xml", "campus logo.svg"));
    expect(normalized.mimetype).toBe("image/webp");
    expect(normalized.originalname).toBe("campus_logo.webp");
    expect(normalized.size).toBeLessThanOrEqual(STORED_UPLOAD_LIMIT_BYTES);
    expect(normalized.buffer.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });

  it("rejects an oversize PDF instead of silently damaging it", async () => {
    const file = upload(Buffer.alloc(STORED_UPLOAD_LIMIT_BYTES + 1), "application/pdf", "proof.pdf");
    await expect(normalizeUpload(file)).rejects.toMatchObject({ status: 413, code: "file_too_large" });
  });

  it("measures actual bytes when multipart size metadata is under-reported", async () => {
    const file = upload(Buffer.alloc(STORED_UPLOAD_LIMIT_BYTES + 1), "application/pdf", "proof.pdf");
    file.size = 1;
    await expect(normalizeUpload(file)).rejects.toMatchObject({ status: 413, code: "file_too_large" });
  });

  it("rejects bytes that merely claim to be an image", async () => {
    await expect(normalizeUpload(upload(Buffer.from("not an image"), "image/png", "fake.png")))
      .rejects.toMatchObject({ status: 415, code: "invalid_image" });
  });
});
