/* ═══════════════════════════════════════════════════════════════
   ESC/POS BYTE BUILDER — pure, profile-driven, testable
   Emits the complete command stream for a rasterized receipt:

     INIT              ESC @
     CODEPAGE          ESC t n            (from profile.codepage)
     RASTER per band   GS v 0 m xL xH yL yH data   (or GS ( L fallback)
                       when profile.rasterCommand = "gs_l")
                       Rows are byte-aligned; bands are emitted back to
                       back with no inter-band gap beyond the profile's
                       interBandGapFix (blank rows appended per band).
     FEED              ESC d n            (profile.feedBeforeCutLines)
     CUT               GS V [66|65] n     (full/partial per profile)
     DRAWER            ESC p m t1 t2      (only when profile.drawerKick)

   Every number (dots, band height, feed, cut mode, pin) comes from
   the printer profile — nothing is hardcoded. Pure byte math: golden-
   byte tests lock init/raster/feed/cut/kick, and the decode test
   reconstructs the bitmap from the stream to assert seam-free output.
   ═══════════════════════════════════════════════════════════════ */

import type { Bitmap1bpp } from "./band-raster";

/** Subset of PrinterProfile the byte builder reads. */
export interface EscPosProfile {
  printableDots: number;
  rasterCommand: "gs_v0" | "gs_l";
  codepage: string;
  bandHeight: number;
  interBandGapFix: number;
  feedBeforeCutLines: number;
  cutMode: "full" | "partial" | "none";
  drawerKick: boolean;
  drawerPin: 2 | 5;
}

/** Common ESC/POS codepage numbers; profile stores the name. */
const CODEPAGE_MAP: Record<string, number> = {
  cp437: 0,
  cp850: 2,
  cp860: 3,
  cp863: 4,
  cp865: 5,
  cp851: 11,
  cp853: 12,
  cp857: 13,
  cp1252: 16,
  cp866: 17,
  cp852: 18,
  cp858: 19,
  // Urdu reaches thermal printers as RASTER, so the codepage only
  // affects the (optional) text driver's latin fragments.
};

export const ESC = 0x1b;
export const GS = 0x1d;

export class ByteWriter {
  private chunks: number[] = [];
  bytes(...bs: number[]): void {
    for (const b of bs) this.chunks.push(b & 0xff);
  }
  u16le(v: number): void {
    this.bytes(v & 0xff, (v >> 8) & 0xff);
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
  get length(): number {
    return this.chunks.length;
  }
}

/** ESC @ — initialize. */
export function buildInit(w: ByteWriter): void {
  w.bytes(ESC, 0x40);
}

/** ESC t n — select codepage (best-effort: unknown names fall back to 0). */
export function buildCodepage(w: ByteWriter, codepage: string): void {
  const n = CODEPAGE_MAP[codepage.toLowerCase()] ?? 0;
  w.bytes(ESC, 0x74, n);
}

/** GS v 0 m xL xH yL yH data — column-format raster (the standard). */
export function buildGsV0(w: ByteWriter, bm: Bitmap1bpp): void {
  const xl = bm.rowBytes & 0xff;
  const xh = (bm.rowBytes >> 8) & 0xff;
  const yl = bm.height & 0xff;
  const yh = (bm.height >> 8) & 0xff;
  w.bytes(GS, 0x76, 0x30, 0x00, xl, xh, yl, yh);
  for (let i = 0; i < bm.data.length; i++) w.bytes(bm.data[i]!);
}

/** GS ( L — function 112 raster (fallback for odd firmware). */
export function buildGsL(w: ByteWriter, bm: Bitmap1bpp): void {
  const dataSize = bm.data.length + 10;
  w.bytes(GS, 0x28, 0x4c);
  w.bytes(dataSize & 0xff, (dataSize >> 8) & 0xff);
  w.bytes(0x30, 0x70, 0x30, 0x00, 0x01, 0x01); // header, mode 1 (raster)
  const xl = bm.rowBytes & 0xff;
  const xh = (bm.rowBytes >> 8) & 0xff;
  const yl = bm.height & 0xff;
  const yh = (bm.height >> 8) & 0xff;
  w.bytes(xl, xh, yl, yh);
  for (let i = 0; i < bm.data.length; i++) w.bytes(bm.data[i]!);
}

/** ESC d n — feed n lines. */
export function buildFeed(w: ByteWriter, lines: number): void {
  w.bytes(ESC, 0x64, Math.max(0, Math.min(255, lines)));
}

/** GS V — cut. Full: 66 m or plain; partial: 66 65 n style varies by
 *  firmware; the common forms are emitted per profile.cutMode. */
export function buildCut(w: ByteWriter, cutMode: "full" | "partial" | "none"): void {
  if (cutMode === "none") return;
  if (cutMode === "full") {
    w.bytes(GS, 0x56, 0x42, 0x00); // full cut, feed to cutting position
  } else {
    w.bytes(GS, 0x56, 0x42, 0x01); // partial cut
  }
}

/** ESC p m t1 t2 — drawer kick pulse on pin 2 (0x30) or 5 (0x31).
 *  t1/t2 = on-time in 2 ms units (default 50 → 100 ms). */
export function buildDrawerKick(w: ByteWriter, pin: 2 | 5, onMs = 100): void {
  const m = pin === 2 ? 0x30 : 0x31;
  const t = Math.max(1, Math.min(255, Math.round(onMs / 2)));
  w.bytes(ESC, 0x70, m, t, t);
}

/**
 * Build the full ESC/POS stream for the receipt's band bitmaps.
 * `bands` come from rasterizeBands (bottom rows already trimmed, so
 * no blank tail beyond the profile's feed_before_cut_lines).
 */
export function buildReceiptStream(bands: Bitmap1bpp[], profile: EscPosProfile): Uint8Array {
  const w = new ByteWriter();
  buildInit(w);
  buildCodepage(w, profile.codepage);

  for (const bm of bands) {
    if (bm.height <= 0) continue;
    if (profile.rasterCommand === "gs_l") buildGsL(w, bm);
    else buildGsV0(w, bm);
    // Gap compensation: some printers lose a row at each seam — append
    // blank rows per band when the profile asks for it.
    for (let i = 0; i < profile.interBandGapFix; i++) {
      w.bytes(ESC, 0x4a, 0x01); // ESC J n — print and feed 1 dot row
    }
  }

  buildFeed(w, profile.feedBeforeCutLines);
  buildCut(w, profile.cutMode);
  if (profile.drawerKick) buildDrawerKick(w, profile.drawerPin);
  return w.toUint8Array();
}

/* ─── Decode helpers (used by the round-trip test — never shipped
       to a printer; they parse what buildReceiptStream wrote) ──── */

export interface DecodedRaster {
  bitmap: Bitmap1bpp;
  /** Feed (ESC d n) found after the last raster block. */
  feedLines: number;
  /** Cut bytes found (null when none). */
  cut: number[] | null;
  /** Drawer kick bytes found (null when none). */
  kick: number[] | null;
}

/**
 * Decode every GS v 0 block in a stream and stitch the bitmaps.
 * Asserts (via the caller's test) that stitching reproduces the
 * source bitmap with no seams.
 */
export function decodeStream(stream: Uint8Array): DecodedRaster {
  let i = 0;
  const bitmaps: Bitmap1bpp[] = [];
  let feedLines = 0;
  let cut: number[] | null = null;
  let kick: number[] | null = null;

  while (i < stream.length) {
    if (stream[i] === GS && stream[i + 1] === 0x76 && stream[i + 2] === 0x30) {
      const rowBytes = stream[i + 4]! | (stream[i + 5]! << 8);
      const height = stream[i + 6]! | (stream[i + 7]! << 8);
      const len = rowBytes * height;
      const data = stream.slice(i + 8, i + 8 + len);
      bitmaps.push({ width: rowBytes * 8, height, data, rowBytes });
      i += 8 + len;
      continue;
    }
    if (stream[i] === ESC && stream[i + 1] === 0x64) {
      feedLines = stream[i + 2]!;
      i += 3;
      continue;
    }
    if (stream[i] === ESC && stream[i + 1] === 0x4a) {
      // ESC J dot feed between bands — part of gap compensation.
      i += 3;
      continue;
    }
    if (stream[i] === GS && stream[i + 1] === 0x56) {
      cut = Array.from(stream.slice(i, i + 4));
      i += 4;
      continue;
    }
    if (stream[i] === ESC && stream[i + 1] === 0x70) {
      kick = Array.from(stream.slice(i, i + 4));
      i += 4;
      continue;
    }
    i++;
  }

  // Stitch without dedup: the emitted bands are contiguous, so plain
  // concatenation must reproduce the source exactly (seam-free).
  const width = bitmaps[0]?.width ?? 0;
  const rowBytes = bitmaps[0]?.rowBytes ?? 0;
  const height = bitmaps.reduce((s, b) => s + b.height, 0);
  const data = new Uint8Array(height * rowBytes);
  let out = 0;
  for (const b of bitmaps) {
    data.set(b.data, out);
    out += b.data.length;
  }
  return { bitmap: { width, height, data, rowBytes }, feedLines, cut, kick };
}
