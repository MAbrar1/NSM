/* ═══════════════════════════════════════════════════════════════
   BAND RASTERIZER — unit tests
   Locks the seam-free band splitting and 1-bit conversion:
   - bands never exceed band_height
   - concatenating bands reproduces the source bitmap exactly
   - the last band trims blank rows (no blank tail)
   - threshold conversion puts ink where pixels are dark
   Run: npx tsx --test tests/band-raster.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rasterizeBands,
  rasterizeRegionTo1bpp,
  stitchBands,
  sliceBitmapRows,
  type Bitmap1bpp,
} from "@/lib/print/band-raster";

/** Build a source ImageData of w×h with (optionally) some dark rows. */
function makeImageData(w: number, h: number, darkRows: number[] = []): ImageData {
  // Node 20+ ships ImageData? Guard: build a duck-typed object when absent.
  const data = new Uint8ClampedArray(w * h * 4).fill(255); // white
  for (const y of darkRows) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  if (typeof ImageData === "undefined") {
    return { data, width: w, height: h, colorSpace: "srgb" } as unknown as ImageData;
  }
  return new ImageData(data, w, h);
}

/** Extract rows [y, y+h) from a full-height image as an ImageData window. */
function windowOf(full: ImageData, w: number, y: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  data.set(full.data.subarray(y * w * 4, (y + h) * w * 4));
  if (typeof ImageData === "undefined") {
    return { data, width: w, height: h, colorSpace: "srgb" } as unknown as ImageData;
  }
  return new ImageData(data, w, h);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let y = Math.max(0, from); y < to; y++) out.push(y);
  return out;
}

test("bands never exceed bandHeight and cover the full source", async () => {
  const W = 64;
  const H = 600;
  // Fully-dark source: every band-local window is dark (rows 0..h).
  const bands = await rasterizeBands(
    { width: W, height: H },
    (_y, h) => makeImageData(W, h, range(0, h)),
    { bandHeight: 256 }
  );
  assert.ok(bands.length >= 3, "600 rows at 256/band → ≥3 bands");
  for (const b of bands) {
    assert.ok(b.height <= 256, `band height ${b.height} ≤ 256`);
  }
  // Coverage: first band starts at 0, last band ends at H.
  assert.equal(bands[0]!.y, 0);
  assert.equal(bands[bands.length - 1]!.y + bands[bands.length - 1]!.height, H);
});

test("stitching bands reproduces the source with no seams", async () => {
  const W = 96;
  const H = 700; // not a multiple of 256 → ragged last band
  const darkRows: number[] = [];
  for (let y = 0; y < H; y += 3) darkRows.push(y); // dashed pattern across seams
  const full = makeImageData(W, H, darkRows);

  const bands = await rasterizeBands(
    { width: W, height: H },
    (y, h) => windowOf(full, W, y, h),
    { bandHeight: 256 }
  );

  const stitched = stitchBands(bands);
  assert.equal(stitched.height, H);
  assert.equal(stitched.width, W);

  // Compare with a direct 1-bit conversion of the whole image.
  const direct = rasterizeRegionTo1bpp(full, 0, 0, W, H, 128);
  assert.deepEqual(stitched.data, direct.data);
});

test("blank tail rows are trimmed from the last band only", async () => {
  const W = 64;
  const contentRows = 300;
  const blankTail = 120;
  const H = contentRows + blankTail;
  // Full source with dark rows 0..299, blank 300..419 — band reads are
  // windowed slices of it.
  const full = makeImageData(W, H, range(0, contentRows));
  const bands = await rasterizeBands(
    { width: W, height: H },
    (y, h) => windowOf(full, W, y, h),
    { bandHeight: 256 }
  );
  const last = bands[bands.length - 1]!;
  // All earlier bands keep full content; the last has no blank rows left.
  const stitchedHeight = bands.reduce((s, b) => s + b.bitmap.height, 0);
  assert.equal(stitchedHeight, contentRows, "blank tail removed");
  assert.ok(last.bitmap.height <= 256);
});

test("1-bit conversion inks dark pixels and keeps rows byte-aligned", () => {
  const img = makeImageData(20, 4, [1]);
  const bm = rasterizeRegionTo1bpp(img, 0, 0, 20, 4, 128);
  assert.equal(bm.rowBytes, Math.ceil(20 / 8));
  assert.equal(bm.height, 4);
  // Row 1 has ink; rows 0/2/3 blank.
  assert.equal(isRowBlank(bm, 0), true);
  assert.equal(isRowBlank(bm, 1), false);
  assert.equal(isRowBlank(bm, 2), true);
});

function isRowBlank(bm: Bitmap1bpp, row: number): boolean {
  for (let b = 0; b < bm.rowBytes; b++) {
    if (bm.data[row * bm.rowBytes + b] !== 0) return false;
  }
  return true;
}

test("sliceBitmapRows copies an exact row range", () => {
  const img = makeImageData(8, 6, [0, 2, 4]);
  const bm = rasterizeRegionTo1bpp(img, 0, 0, 8, 6, 128);
  const mid = sliceBitmapRows(bm, 1, 5);
  assert.equal(mid.height, 4);
  assert.equal(isRowBlank(mid, 0), true);  // source row 1 blank
  assert.equal(isRowBlank(mid, 1), false); // source row 2 dark
  assert.equal(isRowBlank(mid, 3), false); // source row 4 dark
});
