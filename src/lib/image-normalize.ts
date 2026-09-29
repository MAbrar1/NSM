/* ═══════════════════════════════════════════════════════════════
   CLIENT-SIDE IMAGE NORMALIZER
   Runs before upload so EVERY image the system stores is already
   well-behaved — regardless of what the user drops in:

   - auto-orients via createImageBitmap (EXIF rotation respected)
   - downscales to MAX_DIM (long edge) — 2048px covers retina zoom
   - transparency preserved: alpha → WebP; opaque → JPEG q0.85
   - giant pixels-bomb canvases are rejected safely
   - output is a clean File ready for /api/products/:id/image
   ═══════════════════════════════════════════════════════════════ */

export const IMAGE_MAX_DIM = 2048;
export const IMAGE_JPEG_QUALITY = 0.85;

/** Hard cap on canvas pixels (~268MP) — rejects decompression bombs. */
const MAX_CANVAS_PIXELS = 268_435_456;

export interface NormalizeResult {
  file: File;
  width: number;
  height: number;
  /** true when the image was re-encoded (resized or format changed) */
  processed: boolean;
}

/** Client-side: browser support check (all modern browsers pass). */
function supportsCreateImageBitmap(): boolean {
  return typeof createImageBitmap === "function" && typeof OffscreenCanvas !== "undefined";
}

async function decode(file: File): Promise<{ bitmap: ImageBitmap | HTMLImageElement; w: number; h: number }> {
  if (supportsCreateImageBitmap()) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { bitmap, w: bitmap.width, h: bitmap.height };
  }
  // Fallback decode path (older Safari): <img> + object URL. EXIF
  // orientation is applied by the browser when rendering.
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read image"));
      el.src = url;
    });
    return { bitmap: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function drawToCanvas(
  source: ImageBitmap | HTMLImageElement,
  w: number,
  h: number
): HTMLCanvasElement | OffscreenCanvas {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Canvas not supported");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality?: number): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type, quality } as { type: string; quality?: number });
  }
  return new Promise((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Encoding failed"))),
      type,
      quality
    );
  });
}

/**
 * Normalize an image File for upload. Returns the original file when
 * it is already well-behaved (small enough, standard type) so we skip
 * needless re-encoding; the caller's upload flow is unchanged.
 */
export async function normalizeImageFile(file: File): Promise<NormalizeResult> {
  // Non-images and SVGs pass through untouched (server still validates).
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    return { file, width: 0, height: 0, processed: false };
  }

  let w = 0;
  let h = 0;
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    const decoded = await decode(file);
    bitmap = decoded.bitmap;
    w = decoded.w;
    h = decoded.h;
  } catch {
    // Undecodable in-browser (e.g. exotic formats) — send as-is and let
    // the server's validation decide.
    return { file, width: 0, height: 0, processed: false };
  }

  if (!w || !h) return { file, width: 0, height: 0, processed: false };
  if (w * h > MAX_CANVAS_PIXELS) {
    throw new Error("Image dimensions are too large to process");
  }

  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(w, h));
  const needsResize = scale < 1;
  const needsReencode = !["image/jpeg", "image/webp"].includes(file.type);
  if (!needsResize && !needsReencode && file.size <= 5 * 1024 * 1024) {
    return { file, width: w, height: h, processed: false };
  }

  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const canvas = drawToCanvas(bitmap, outW, outH);
  if ("close" in bitmap) bitmap.close();

  // Transparency-aware encoding: alpha → WebP (keeps PNG translucency),
  // opaque → JPEG (smaller). GIF animation would be lost → keep original.
  const hasAlpha = file.type === "image/png" || file.type === "image/webp";
  const type = file.type === "image/gif" ? file.type : hasAlpha ? "image/webp" : "image/jpeg";
  const blob = await canvasToBlob(canvas, type, IMAGE_JPEG_QUALITY);

  const ext = type === "image/webp" ? "webp" : "jpg";
  const base = (file.name.replace(/\.[^.]+$/, "") || "image").slice(0, 60);
  const out = new File([blob], `${base}.${ext}`, { type });

  // Choose whichever is smaller: the re-encode or the original.
  if (out.size >= file.size && !needsResize) {
    return { file, width: w, height: h, processed: false };
  }
  return { file: out, width: outW, height: outH, processed: true };
}

/** Human label for the size hint under uploaders. */
export function imageMaxDimLabel(): string {
  return `${IMAGE_MAX_DIM}px`;
}
