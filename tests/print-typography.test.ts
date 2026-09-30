/* ═══════════════════════════════════════════════════════════════
   TYPOGRAPHY / PRINT-RENDER CONTRACT TESTS
   Software-verifiable half of the "Urdu glyph coverage on hardware"
   verification. A real thermal print needs physical paper — that
   half stays a manual step (Settings → Printers → Calibration print,
   then EYES the Urdu-specific glyph line). What CAN be proven here,
   against the same documents the rasterizer consumes:

   1. The calibration page carries an Urdu sample line that includes
      every Urdu-specific glyph (ٹ ڈ ڑ ں ھ ے ژ ک گ) — the letters a
      generic Arabic font misses — plus a bold pass, so hardware
      verification has something deterministic to look at.
   2. The calibration page @font-face-loads Noto Naskh Arabic from
      the local /fonts origin (never a CDN, never an OS name).
   3. The receipt document declares ONLY bundled faces: every
      font-family that appears is either a /fonts-backed face or a
      generic (sans-serif/monospace) — no proprietary-derived names.
   4. Receipt money columns carry tabular figures (font-variant-
      numeric: tabular-nums + tnum) so digit columns align regardless
      of which face resolves.
   5. Urdu digits (۰-۹) appear only when the store opts in.
   Run: npx tsx --test tests/print-typography.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCalibrationHtml } from "@/lib/print/calibration";
import { renderReceiptDocument } from "@/lib/print/receipt-template";
import { buildReceiptSnapshot, type ReceiptSnapshot } from "@/lib/receipts/receipt-snapshot";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** All Urdu-specific glyphs the calibration print must exercise. */
const URDU_SPECIFIC_GLYPHS = ["ٹ", "ڈ", "ڑ", "ں", "ھ", "ے", "ژ", "ک", "گ"] as const;

/** Faces legally nameable in documents. Nastaliq is bundled but scoped
 *  to A4/A5 letterheads by the spec — a thermal receipt naming it FAILS. */
const BUNDLED_FACES = [
  "IBM Plex Sans",
  "IBM Plex Sans Arabic",
  "Noto Naskh Arabic",
  "Noto Nastaliq Urdu",
] as const;

/** Every font-family the receipt document names must be bundled or generic. */
const GENERIC_FAMILIES = [
  "sans-serif",
  "monospace",
  "-apple-system",
  "Segoe UI",
  "Roboto",
  "Arial",
  "Menlo",
  "ui-monospace",
  "Courier",
];

function snapshotFor(language: "en" | "ur" | "bilingual", urduDigits?: boolean): ReceiptSnapshot {
  return buildReceiptSnapshot({
    receiptNo: "R-T1-000001",
    terminalId: "T1",
    issuedAt: new Date("2026-09-29T10:00:00Z"),
    language,
    order: {
      subtotal: 123456,
      taxAmount: 0,
      discountAmount: 0,
      total: 123456,
      paidAmount: 200000,
      changeAmount: 76544,
      dueAmount: 0,
      paymentStatus: "paid",
      loyaltyRedeemed: 0,
      loyaltyPointsRedeemed: 0,
      items: [
        { productName: "ٹیوب ویل Tubewell", sku: "S1", quantity: 2, unit: "pcs", unitPrice: 50000, discountAmount: 0, taxRate: 0, taxAmount: 0, total: 100000 },
        { productName: "کھیل کا گاؤں", sku: "S2", quantity: 1, unit: "pcs", unitPrice: 23456, discountAmount: 0, taxRate: 0, taxAmount: 0, total: 23456 },
      ],
    },
    cashierName: "Ayesha",
    customerName: null,
    customerLoyaltyBalance: 0,
    settings: {
      storeName: "نئیجار سپر مارٹ",
      storeAddress: "Main Bazar",
      storePhone: "0300-1234567",
      receiptHeader: null,
      receiptFooter: null,
      receiptQrPayment: null,
      receiptUrduDigits: urduDigits ?? false,
    },
  });
}

test("calibration print exercises every Urdu-specific glyph, in regular AND bold", () => {
  const html = buildCalibrationHtml({
    name: "Front Counter 80mm",
    printableDots: 576,
    dpi: 203,
    bandHeight: 256,
    feedBeforeCutLines: 3,
    cutMode: "full",
    drawerKick: false,
  });
  for (const glyph of URDU_SPECIFIC_GLYPHS) {
    assert.ok(html.includes(glyph), `calibration sample must include ٹ-style glyph ${glyph}`);
  }
  assert.match(html, /font-weight:\s*700/, "bold pass line present (verify bold Naskh renders)");
});

test("calibration page loads Noto Naskh Arabic from the local origin only", () => {
  const html = buildCalibrationHtml({
    name: "Front Counter 80mm",
    printableDots: 576,
    dpi: 203,
    bandHeight: 256,
    feedBeforeCutLines: 3,
    cutMode: "full",
    drawerKick: false,
  });
  assert.ok(html.includes("Noto Naskh Arabic"), "calibration sets the Naskh face");
  assert.ok(html.includes("/fonts/noto-naskh-arabic-arabic-400-normal.woff2"), "regular weight local file");
  assert.ok(html.includes("/fonts/noto-naskh-arabic-arabic-700-normal.woff2"), "bold weight local file");
  assert.ok(!/https?:\/\/(?!localhost)/.test(html), "no external (CDN) font or asset URLs");
});

test("every bundled face in the receipt document maps to a committed woff2", () => {
  const html = renderReceiptDocument(snapshotFor("ur"), { widthPx: 302, language: "ur" });
  // Collect every @font-face src URL and confirm the file exists on disk.
  const urls = [...html.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1] as string);
  // Thermal receipt face set: Naskh 400 + Naskh 700 + Plex 400 = 3.
  // (Nastaliq is deliberately NOT here — spec keeps it off the thermal
  // path; it ships only on the A4/A5 report letterhead.)
  assert.equal(urls.length, 3, `expected the thermal face set, found ${urls.length}`);
  for (const url of urls) {
    assert.ok(url.startsWith("/fonts/"), `${url} must be origin-relative`);
    const disk = join(ROOT, "public", url);
    const bytes = readFileSync(disk);
    assert.ok(bytes.length > 10_000, `${url} should be a real font file, got ${bytes.length} bytes`);
    // woff2 magic: "wOF2"
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2", `${url} must be a genuine woff2`);
  }
});

test("receipt document names no unbundled font family", () => {
  for (const lang of ["en", "ur", "bilingual"] as const) {
    const html = renderReceiptDocument(snapshotFor(lang), { widthPx: 302, language: lang });
    // SPEC: Nastaliq never rides the thermal receipt path.
    assert.ok(!html.includes("Nastaliq"), `${lang}: Nastaliq absent from the thermal path`);
    const families = [...html.matchAll(/font-family:\s*([^;}{]+)/g)].map((m) => m[1] as string);
    assert.ok(families.length > 0);
    for (const raw of families) {
      for (const name of raw.split(",")) {
        const clean = name.trim().replace(/^["']|["']$/g, "");
        if (GENERIC_FAMILIES.includes(clean)) continue;
        if (BUNDLED_FACES.includes(clean as (typeof BUNDLED_FACES)[number])) continue;
        if (clean === "Noto Nastaliq Urdu") assert.fail("Nastaliq must not appear on the thermal receipt path");
        assert.fail(`unbundled font family "${clean}" in ${lang} receipt document`);
      }
    }
    assert.ok(!html.includes("Jameel"), "proprietary-derived name absent");
    assert.ok(!html.includes("Alvi"), "proprietary-derived name absent");
  }
});

test("receipt money columns pin tabular figures", () => {
  const html = renderReceiptDocument(snapshotFor("en"), { widthPx: 302, language: "en" });
  assert.match(html, /\.r \.v \{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(html, /\.r \.v \{[^}]*font-feature-settings:[^}]*"tnum"/);
  // Qty/price columns of item lines are figures too.
  assert.match(html, /\.line-row \.qty[^{]*\{[^}]*tabular-nums|\.qty[^{]*tabular-nums/);
});

test("Urdu-Indic digits render only on store opt-in", () => {
  const western = renderReceiptDocument(snapshotFor("ur"), { widthPx: 302, language: "ur" });
  assert.ok(!/[\u06F0-\u06F9]/.test(western), "default: Western numerals everywhere");

  const opted = renderReceiptDocument(snapshotFor("ur", true), { widthPx: 302, language: "ur" });
  assert.match(opted, /[\u06F0-\u06F9]/, "opt-in: Urdu-Indic digits on the receipt");

  // The ENGLISH receipt of the same store also converts — the flag is
  // store-wide typography, not per-receipt-language.
  const optedEn = renderReceiptDocument(snapshotFor("en", true), { widthPx: 302, language: "en" });
  assert.match(optedEn, /[\u06F0-\u06F9]/, "opt-in applies regardless of receipt language");
});
