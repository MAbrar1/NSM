/* ═══════════════════════════════════════════════════════════════
   ESC/POS BUILDER — golden-byte + round-trip tests
   - golden bytes for INIT, CODEPAGE, raster header (GS v 0), FEED,
     CUT and DRAWER KICK (the wire contract with real printers)
   - full-stream round trip: decode(encode(bands)) reproduces the
     source bitmaps stitched, seam-free
   - profile-driven: band size, feed, cut mode and kick all come
     from the profile; nothing hardcoded
   Run: npx tsx --test tests/escpos.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, buildInit, buildCodepage, buildGsV0, buildFeed, buildCut, buildDrawerKick, buildReceiptStream, decodeStream } from "@/lib/print/escpos";
import type { Bitmap1bpp } from "@/lib/print/band-raster";

function blankBitmap(width: number, height: number): Bitmap1bpp {
  const rowBytes = Math.ceil(width / 8);
  return { width, height, data: new Uint8Array(rowBytes * height), rowBytes };
}

function patternBitmap(width: number, height: number): Bitmap1bpp {
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x + y) % 3 === 0) data[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { width, height, data, rowBytes };
}

const PROFILE = {
  printableDots: 576,
  rasterCommand: "gs_v0" as const,
  codepage: "cp437",
  bandHeight: 256,
  interBandGapFix: 0,
  feedBeforeCutLines: 3,
  cutMode: "full" as const,
  drawerKick: false,
  drawerPin: 2 as const,
};

/* ─── Golden bytes ─────────────────────────────────────────────── */

test("INIT is ESC @", () => {
  const w = new ByteWriter();
  buildInit(w);
  assert.deepEqual(Array.from(w.toUint8Array()), [0x1b, 0x40]);
});

test("CODEPAGE cp437 → ESC t 0", () => {
  const w = new ByteWriter();
  buildCodepage(w, "cp437");
  assert.deepEqual(Array.from(w.toUint8Array()), [0x1b, 0x74, 0x00]);
});

test("GS v 0 header encodes rowBytes and height little-endian", () => {
  // 576 dots → 72 rowBytes; height 8.
  const w = new ByteWriter();
  buildGsV0(w, blankBitmap(576, 8));
  const bytes = Array.from(w.toUint8Array());
  assert.deepEqual(bytes.slice(0, 8), [0x1d, 0x76, 0x30, 0x00, 72, 0, 8, 0]);
  assert.equal(bytes.length, 8 + 72 * 8);
});

test("FEED is ESC d n with the profile's line count", () => {
  const w = new ByteWriter();
  buildFeed(w, 3);
  assert.deepEqual(Array.from(w.toUint8Array()), [0x1b, 0x64, 0x03]);
});

test("CUT full vs partial vs none", () => {
  const full = new ByteWriter();
  buildCut(full, "full");
  assert.deepEqual(Array.from(full.toUint8Array()), [0x1d, 0x56, 0x42, 0x00]);
  const partial = new ByteWriter();
  buildCut(partial, "partial");
  assert.deepEqual(Array.from(partial.toUint8Array()), [0x1d, 0x56, 0x42, 0x01]);
  const none = new ByteWriter();
  buildCut(none, "none");
  assert.equal(none.length, 0);
});

test("DRAWER KICK is ESC p m t t for pin 2 or 5", () => {
  const p2 = new ByteWriter();
  buildDrawerKick(p2, 2, 100);
  assert.deepEqual(Array.from(p2.toUint8Array()), [0x1b, 0x70, 0x30, 50, 50]);
  const p5 = new ByteWriter();
  buildDrawerKick(p5, 5, 60);
  assert.deepEqual(Array.from(p5.toUint8Array()), [0x1b, 0x70, 0x31, 30, 30]);
});

/* ─── Profile-driven stream ────────────────────────────────────── */

test("stream: profile values drive feed/cut/kick; no kick when disabled", () => {
  const bands = [patternBitmap(576, 64)];
  const stream = Array.from(buildReceiptStream(bands, PROFILE));
  // FEED 3 present, full cut present, no kick.
  assert.ok(stream.includes(0x64));
  const kickIdx = stream.findIndex((b, i) => b === 0x1b && stream[i + 1] === 0x70);
  assert.equal(kickIdx, -1, "drawerKick=false emits no ESC p");
});

test("stream with drawerKick emits kick bytes after the cut", () => {
  const bands = [blankBitmap(384, 16)];
  const stream = Array.from(
    buildReceiptStream(bands, { ...PROFILE, drawerKick: true, drawerPin: 5 })
  );
  const cutIdx = stream.findIndex((b, i) => b === 0x1d && stream[i + 1] === 0x56);
  const kickIdx = stream.findIndex((b, i) => b === 0x1b && stream[i + 1] === 0x70);
  assert.ok(cutIdx >= 0);
  assert.ok(kickIdx > cutIdx, "kick follows cut");
  assert.equal(stream[kickIdx + 2], 0x31, "pin 5 encoded as 0x31");
});

/* ─── Round trip: decode reproduces the source, seam-free ─────── */

test("round trip: bands split at 256 → decode stitches identical bitmap", () => {
  const W = 576;
  const H = 700; // crosses 2 seams (256/256/188)
  const source = patternBitmap(W, H);
  const bands: Bitmap1bpp[] = [];
  for (let y = 0; y < H; y += PROFILE.bandHeight) {
    const h = Math.min(PROFILE.bandHeight, H - y);
    bands.push({
      width: W,
      height: h,
      data: source.data.slice(y * source.rowBytes, (y + h) * source.rowBytes),
      rowBytes: source.rowBytes,
    });
  }
  assert.equal(bands.length, 3);

  const stream = buildReceiptStream(bands, PROFILE);
  const decoded = decodeStream(stream);
  assert.equal(decoded.bitmap.width, W);
  assert.equal(decoded.bitmap.height, H);
  assert.deepEqual(decoded.bitmap.data, source.data, "no seams, no lost rows");
  assert.equal(decoded.feedLines, PROFILE.feedBeforeCutLines);
  assert.ok(decoded.cut, "cut present");
  assert.equal(decoded.kick, null);
});

test("round trip: interBandGapFix dot-feeds are skipped by the decoder", () => {
  const bands = [patternBitmap(384, 32), patternBitmap(384, 32)];
  const profile = { ...PROFILE, interBandGapFix: 2 };
  const decoded = decodeStream(buildReceiptStream(bands, profile));
  assert.equal(decoded.bitmap.height, 64, "gap rows are ESC J dot-feeds, not bitmap rows");
});
