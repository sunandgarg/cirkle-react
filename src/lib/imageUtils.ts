/**
 * Image optimization utilities - converts images to WebP and compresses on the fly.
 */

/**
 * Convert a File to WebP format with compression.
 * @param file - Original image file
 * @param quality - WebP quality (0-1), default 0.75
 * @param maxWidth - Max width in px, default 1200
 * @returns A new File in WebP format
 */
export const COMMUNITY_IMAGE_TARGET_BYTES = 512 * 1024;
export const FILE_UPLOAD_LIMIT_BYTES = 512 * 1024;
export const IMAGE_SOURCE_LIMIT_BYTES = 10 * 1024 * 1024;

export const nextCommunityImageCompression = (
  width: number,
  height: number,
  quality: number,
): { width: number; height: number; quality: number } => quality > 0.5
  ? { width, height, quality: Math.max(0.5, quality - 0.08) }
  : { width: Math.max(1, Math.round(width * 0.85)), height: Math.max(1, Math.round(height * 0.85)), quality };

export const convertToWebP = (
  file: File,
  quality = 0.75,
  maxWidth = 1200,
  maxBytes = COMMUNITY_IMAGE_TARGET_BYTES,
): Promise<File> => {
  return new Promise((resolve, reject) => {
    // If not an image, return as-is
    if (!file.type.startsWith("image/")) {
      resolve(file);
      return;
    }
    if (file.size > IMAGE_SOURCE_LIMIT_BYTES) {
      reject(new Error("Image must be under 10 MB before compression"));
      return;
    }

    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let w = img.width;
      let h = img.height;

      // Scale down if wider than maxWidth
      if (w > maxWidth) {
        h = Math.round((h * maxWidth) / w);
        w = maxWidth;
      }

      void (async () => {
        let output: Blob | null = null;
        let currentQuality = quality;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w));
          canvas.height = Math.max(1, Math.round(h));
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas not supported");
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          output = await canvasBlob(canvas, "image/webp", currentQuality);
          if (output.size <= maxBytes || canvas.width <= 320 || canvas.height <= 320) break;
          ({ width: w, height: h, quality: currentQuality } = nextCommunityImageCompression(w, h, currentQuality));
        }
        if (!output) throw new Error("WebP conversion failed");
        if (output.size > maxBytes) throw new Error("Image could not be compressed below the upload target");
        const baseName = file.name.replace(/\.[^.]+$/, "");
        resolve(new File([output], `${baseName}.webp`, { type: "image/webp", lastModified: Date.now() }));
      })().catch(reject);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This image could not be opened"));
    };

    img.src = url;
  });
};

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image compression failed")), type, quality);
  });

/**
 * Convert a profile or cover photo to WebP and keep it below the common
 * 0.5 MiB stored-object limit.
 */
export const compressProfileImage = async (file: File, maxWidth: number): Promise<File> => {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file");
  if (file.size > IMAGE_SOURCE_LIMIT_BYTES) throw new Error("Image must be under 10 MB");
  return convertToWebP(file, 0.82, maxWidth, COMMUNITY_IMAGE_TARGET_BYTES);
};

export const assertSmallFile = (file: Pick<File, "size" | "type">): void => {
  if (file.type.startsWith("image/")) {
    if (file.size > IMAGE_SOURCE_LIMIT_BYTES) throw new Error("Image must be under 10 MB before compression");
    return;
  }
  if (file.size > FILE_UPLOAD_LIMIT_BYTES) {
    throw new Error("PDFs, documents, audio, and video must be 0.5 MB or smaller");
  }
};

/**
 * Get an optimized Supabase storage URL with transforms (if supported).
 * Falls back to original URL if transforms not available.
 */
export const getOptimizedImageUrl = (
  url: string,
  width = 400,
  quality = 75
): string => {
  if (!url) return url;
  // Supabase storage transform URL pattern
  if (url.includes("/storage/v1/object/public/")) {
    return url.replace(
      "/storage/v1/object/public/",
      `/storage/v1/render/image/public/`
    ) + `?width=${width}&quality=${quality}`;
  }
  return url;
};
