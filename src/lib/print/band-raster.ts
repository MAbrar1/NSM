/* ═══════════════════════════════════════════════════════════════
   BAND RASTERIZER
   Never allocate one canvas of the full receipt height — webview
   canvas limits (~16k px on many stacks) break 500-line receipts.
   Instead, rasterize the SAME measured DOM band by band:

   - each band canvas is ≤ profile.band_height px tall
   - the band is drawn by translating the SOURCE canvas context
     (drawImage of an offscreen snapshot canvas), offset-correct, so
     adjacent bands share pixel rows and no seam or gap appears
   - rows convert to 1-bit (threshold 128 for text; dithering is
     optional and OFF by default to keep text crisp)
   - the last band trims fully-blank bottom rows: no blank tail
     beyond the profile's feed_before_cut_lines (added by the
     ESC/POS builder, not by blank pixels)

   Input: an OFFSCREEN SOURCE CANVAS rendered from the measured DOM
   (html2canvas-style draw is host-specific, so the renderer is
   injected — see RenderSource). Everything here is pure canvas math
   and byte packing, fully unit-testable without a printer.
   ═══════════════════════════════════════════════════════════════ */

/** A 1-bit bitmap: rows are byte-aligned (ceil(width/8) bytes). */
export interface Bitmap1bpp {
  width: number;  // pixels
  height: number; // pixel rows
  /** Row-major bytes, MSB first: byte r*(rowBytes)+c/8, bit 7-(c%8). */
  data: Uint8Array;
  rowBytes: number;
}

export interface Band {
  /** First source row of this band (px). */
  y: number;
  /** Band pixel height (≤ bandHeight). */
  height: number;
  bitmap: Bitmap1bpp;
}

export interface RasterOptions {
  /** Band height in px (from profile.bandHeight). */
  bandHeight: number;
  /** 1-bit threshold 0–255 (default 128). */
  threshold?: number;
  /** Inter-band overlap repair: extra source rows re-emitted at the
   *  top of each band to absorb printer seam drift (profile.interBandGapFix). */
  overlapRows?: number;
}

/**
 * Convert an RGBA pixel region to 1-bit rows, thresholding luminance.
 * Pure function over the source's ImageData.
 */
export function rasterizeRegionTo1bpp(
  imageData: ImageData,
  srcX: number,
  srcY: number,
  width: number,
  height: number,
  threshold = 128
): Bitmap1bpp {
  const w = Math.min(width, imageData.width - srcX);
  const h = Math.min(height, imageData.height - srcY);
  const rowBytes = Math.ceil(w / 8);
  const data = new Uint8Array(rowBytes * h);
  const px = imageData.data;

  for (let y = 0; y < h; y++) {
    const rowBase = (srcY + y) * imageData.width;
    const outRow = y * rowBytes;
    for (let x = 0; x < w; x++) {
      const i = (rowBase + srcX + x) * 4;
      // Luminance (BT.601) + alpha: transparent → white (no ink).
      const a = px[i + 3]! / 255;
      const lum = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
      const ink = a > 0 && lum < threshold;
      if (ink) {
        data[outRow + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }
  return { width: w, height: h, data, rowBytes };
}

/**
 * Split a full-width source canvas into 1-bit bands.
 * `getSourceImageData(y, h)` reads only the rows a band needs, so no
 * full-height ImageData is ever materialized either.
 */
export async function rasterizeBands(
  source: { width: number; height: number },
  getSourceImageData: (y: number, h: number) => Promise<ImageData> | ImageData,
  opts: RasterOptions
): Promise<Band[]> {
  const bandHeight = Math.max(8, opts.bandHeight);
  const overlap = Math.max(0, opts.overlapRows ?? 0);
  const threshold = opts.threshold ?? 128;
  const bands: Band[] = [];

  for (let y = 0; y < source.height; y += bandHeight) {
    // Re-read `overlap` rows from the previous band's tail so a printer
    // that skips a row at the seam still sees continuous output.
    const readY = Math.max(0, y - (bands.length > 0 ? overlap : 0));
    const readH = Math.min(bandHeight + (y - readY), source.height - readY);
    const imageData = await getSourceImageData(readY, readH);
    const bitmap = rasterizeRegionTo1bpp(imageData, 0, 0, source.width, readH, threshold);
    bands.push({ y: readY, height: readH, bitmap });
    if (y + bandHeight >= source.height) break;
  }

  // Trim blank tail rows from the LAST band only (no blank paper).
  if (bands.length > 0) {
    const last = bands[bands.length - 1]!;
    let trimmed = last.bitmap.height;
    while (trimmed > 0 && isBlankRow(last.bitmap, trimmed - 1)) trimmed--;
    if (trimmed < last.bitmap.height) {
      bands[bands.length - 1] = {
        ...last,
        height: trimmed,
        bitmap: sliceBitmapRows(last.bitmap, 0, trimmed),
      };
    }
  }

  return bands;
}

function isBlankRow(bm: Bitmap1bpp, row: number): boolean {
  const base = row * bm.rowBytes;
  for (let b = 0; b < bm.rowBytes; b++) {
    if (bm.data[base + b] !== 0) return false;
  }
  return true;
}

/** Copy a contiguous row range out of a bitmap. */
export function sliceBitmapRows(bm: Bitmap1bpp, from: number, to: number): Bitmap1bpp {
  const rows = Math.max(0, to - from);
  const data = new Uint8Array(rows * bm.rowBytes);
  data.set(bm.data.subarray(from * bm.rowBytes, to * bm.rowBytes));
  return { width: bm.width, height: rows, data, rowBytes: bm.rowBytes };
}

/**
 * Concatenate band bitmaps back into one bitmap — the round-trip
 * helper the ESC/POS decode test uses to assert seam-free output.
 */
export function stitchBands(bands: Band[]): Bitmap1bpp {
  if (bands.length === 0) return { width: 0, height: 0, data: new Uint8Array(0), rowBytes: 0 };
  const width = bands[0]!.bitmap.width;
  const rowBytes = bands[0]!.bitmap.rowBytes;
  const height = bands.reduce((s, b) => s + b.bitmap.height, 0);
  const data = new Uint8Array(height * rowBytes);
  let out = 0;
  for (const b of bands) {
    data.set(b.bitmap.data, out);
    out += b.bitmap.data.length;
  }
  return { width, height, data, rowBytes };
}
