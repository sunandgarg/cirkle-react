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
export const convertToWebP = (
  file: File,
  quality = 0.75,
  maxWidth = 1200
): Promise<File> => {
  return new Promise((resolve, reject) => {
    // If not an image, return as-is
    if (!file.type.startsWith("image/")) {
      resolve(file);
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

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas not supported")); return; }

      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error("WebP conversion failed")); return; }
          const baseName = file.name.replace(/\.[^.]+$/, "");
          const webpFile = new File([blob], `${baseName}.webp`, { type: "image/webp" });
          resolve(webpFile);
        },
        "image/webp",
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Fallback: return original file
      resolve(file);
    };

    img.src = url;
  });
};

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image compression failed")), type, quality);
  });

/**
 * Compress a profile or cover photo without changing it to WebP.
 * JPEG remains JPEG and PNG remains PNG. The encoder targets at least a 30%
 * byte reduction and caps the result below the avatars bucket limit.
 */
export const compressProfileImage = async (
  file: File,
  maxWidth: number,
  targetRatio = 0.7,
): Promise<File> => {
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    throw new Error('Choose a JPEG or PNG image');
  }
  if (file.size > 25 * 1024 * 1024) throw new Error('Image must be under 25 MB');

  const image = new Image();
  const objectUrl = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('This image could not be opened'));
      image.src = objectUrl;
    });

    let width = Math.min(image.naturalWidth, maxWidth);
    let height = Math.max(1, Math.round(image.naturalHeight * (width / image.naturalWidth)));
    const targetBytes = Math.min(Math.floor(file.size * targetRatio), 4_500_000);
    const mime = file.type;
    let quality = mime === 'image/jpeg' ? 0.88 : undefined;
    let blob: Blob | null = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const context = canvas.getContext('2d', { alpha: mime === 'image/png' });
      if (!context) throw new Error('Image processing is unavailable in this browser');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await canvasBlob(canvas, mime, quality);
      if (blob.size <= targetBytes || width <= 64 || height <= 64) break;
      if (mime === 'image/jpeg' && quality && quality > 0.54) quality = Math.max(0.54, quality - 0.09);
      else {
        width *= 0.86;
        height *= 0.86;
      }
    }

    if (!blob) throw new Error('Image compression failed');
    const extension = mime === 'image/png' ? 'png' : 'jpg';
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'profile-photo';
    return new File([blob], `${baseName}.${extension}`, { type: mime, lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(objectUrl);
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
