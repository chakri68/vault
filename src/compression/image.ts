/**
 * §14.1 and §15, in the browser and nowhere else.
 *
 * Both jobs are the same move: decode the picture, draw it on a canvas, encode
 * it again. A canvas holds pixels and nothing but pixels, so location, camera,
 * timestamps, embedded thumbnails and colour profiles are gone by construction
 * — there's no list of tags to keep up to date. Orientation is applied on
 * decode, so dropping the orientation tag doesn't turn the photo sideways.
 *
 * Runs in a worker where OffscreenCanvas exists (image-client.ts), on the page
 * otherwise. The original is never modified; callers choose which to keep.
 */
type Bytes = Uint8Array<ArrayBuffer>;

export interface ProcessedImage {
  bytes: Bytes;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
}

export interface OptimiseOptions {
  /** longest edge in px. Documents stay legible well below camera resolution. */
  maxEdge?: number;
  quality?: number;
  /**
   * For identity documents: full resolution, high-quality JPEG. A compressed
   * Aadhaar that a government portal rejects is worse than a large one.
   */
  maximumQuality?: boolean;
}

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Types a browser can reliably decode. HEIC only decodes in Safari; we try, and say so when it fails. */
export function isProcessableImage(mimeType: string): boolean {
  return /^image\/(jpeg|png|webp|heic|heif|avif|bmp|gif)$/i.test(mimeType);
}

export class ImageDecodeError extends Error {
  constructor() {
    super("could not decode image");
    this.name = "ImageDecodeError";
  }
}

async function decode(bytes: Bytes, mimeType: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([bytes], { type: mimeType }), { imageOrientation: "from-image" });
  } catch {
    throw new ImageDecodeError();
  }
}

async function encode(bitmap: ImageBitmap, width: number, height: number, type: string, quality?: number): Promise<Blob> {
  const opaque = type === "image/jpeg";
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: !opaque });
    if (!ctx) throw new ImageDecodeError();
    if (opaque) {
      // JPEG has no transparency; without this a transparent PNG comes out black
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: !opaque });
  if (!ctx) throw new ImageDecodeError();
  if (opaque) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ImageDecodeError())), type, quality));
}

/** Asks for `type`; if the browser can't write it (Safari and WebP), it quietly hands back PNG — so retry as JPEG. */
async function encodeWithFallback(
  bitmap: ImageBitmap, width: number, height: number, type: string, quality: number | undefined, fallbackQuality: number,
): Promise<Blob> {
  const blob = await encode(bitmap, width, height, type, quality);
  if (blob.type === type) return blob;
  return encode(bitmap, width, height, "image/jpeg", fallbackQuality);
}

async function finish(blob: Blob, width: number, height: number): Promise<ProcessedImage> {
  const mimeType = blob.type || "image/jpeg";
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()) as Bytes,
    mimeType, extension: EXTENSION[mimeType] ?? "jpg", width, height,
  };
}

export async function imageDimensions(bytes: Bytes, mimeType: string): Promise<{ width: number; height: number }> {
  const bitmap = await decode(bytes, mimeType);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Same picture, same format, same size — minus everything that isn't the picture. */
export async function stripMetadata(bytes: Bytes, mimeType: string): Promise<ProcessedImage> {
  const bitmap = await decode(bytes, mimeType);
  try {
    const type = mimeType === "image/png" || mimeType === "image/webp" ? mimeType : "image/jpeg";
    const blob = await encodeWithFallback(bitmap, bitmap.width, bitmap.height, type, type === "image/png" ? undefined : 0.92, 0.92);
    return await finish(blob, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** A smaller copy for the vault: 2560 px on the long edge, WebP where the browser can write it. */
export async function optimiseImage(bytes: Bytes, mimeType: string, opts: OptimiseOptions = {}): Promise<ProcessedImage> {
  const bitmap = await decode(bytes, mimeType);
  try {
    const maxEdge = opts.maximumQuality ? Infinity : (opts.maxEdge ?? 2560);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const blob = opts.maximumQuality
      ? await encode(bitmap, width, height, "image/jpeg", 0.95)
      : await encodeWithFallback(bitmap, width, height, "image/webp", opts.quality ?? 0.8, opts.quality ?? 0.8);
    return await finish(blob, width, height);
  } finally {
    bitmap.close();
  }
}
