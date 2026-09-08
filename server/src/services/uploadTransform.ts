import type { Express } from "express";
import sharp from "sharp";
import { ApiError } from "../lib/errors.js";

export const STORED_UPLOAD_LIMIT_BYTES = 512 * 1024;
export const IMAGE_SOURCE_LIMIT_BYTES = 10 * 1024 * 1024;

sharp.cache({ memory: 16, files: 0, items: 50 });
sharp.concurrency(1);

const safeWebpName = (name: string): string => {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 240) || "image";
  return `${base}.webp`;
};

export function assertUncompressedUploadAllowed(file: Pick<Express.Multer.File, "mimetype" | "size">): void {
  if (file.mimetype.startsWith("image/")) {
    if (file.size > IMAGE_SOURCE_LIMIT_BYTES) {
      throw new ApiError(413, "image_source_too_large", "Choose an image smaller than 10 MB");
    }
    return;
  }
  if (file.size > STORED_UPLOAD_LIMIT_BYTES) {
    throw new ApiError(413, "file_too_large", "Documents, PDFs, audio, and video must be 0.5 MB or smaller");
  }
}

async function imageToWebp(buffer: Buffer): Promise<Buffer> {
  let width = 1_600;
  let quality = 82;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const output = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: 20_000_000,
      sequentialRead: true,
    })
      .rotate()
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .webp({ quality, effort: 5, smartSubsample: true })
      .toBuffer();
    if (output.length <= STORED_UPLOAD_LIMIT_BYTES) return output;
    if (quality > 46) quality = Math.max(46, quality - 8);
    else width = Math.max(320, Math.round(width * 0.82));
  }
  throw new ApiError(413, "image_compression_limit", "This image could not be compressed below 0.5 MB");
}

export async function normalizeUpload(file: Express.Multer.File): Promise<Express.Multer.File> {
  assertUncompressedUploadAllowed(file);
  if (!file.mimetype.startsWith("image/")) return file;
  let buffer: Buffer;
  try {
    buffer = await imageToWebp(file.buffer);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(415, "invalid_image", "This image could not be opened safely");
  }
  return {
    ...file,
    buffer,
    size: buffer.length,
    mimetype: "image/webp",
    originalname: safeWebpName(file.originalname),
  };
}
