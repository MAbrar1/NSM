/* ═══════════════════════════════════════════════════════════════
   BARCODE UTILITIES — unit tests
   Locks the scan-parsing layer shared by the camera scanner, the
   USB/Bluetooth keyboard-wedge listener and manual entry:
   - GTIN mod-10 check digits (EAN-8/UPC-A/EAN-13/GTIN-14)
   - Symbology-prefix + GS1 payload extraction (1D and 2D)
   - UPC-A ↔ EAN-13 ↔ GTIN-14 candidate expansion
   Run: npx tsx --test tests/barcode.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gtinCheckDigit,
  isValidGtin,
  normalizeScannedCode,
  normalizeGtin,
  barcodeCandidates,
  extractProductCode,
  parseScan,
} from "@/lib/products/barcode";

/* ─── GTIN check digit ─────────────────────────────────────── */

test("gtinCheckDigit computes the mod-10 GTIN check digit", () => {
  // Canonical GS1 examples (payload = code minus check digit)
  assert.equal(gtinCheckDigit("400638133393"), 1);   // → EAN-13 4006381333931
  assert.equal(gtinCheckDigit("01234567890"), 5);    // → UPC-A 012345678905
});

test("gtinCheckDigit for EAN-8 payload", () => {
  assert.equal(gtinCheckDigit("9638507"), 4);        // 96385074 is the classic example
});

test("isValidGtin accepts real retail codes and rejects misreads", () => {
  assert.equal(isValidGtin("4006381333931"), true);  // EAN-13 (Red Bull)
  assert.equal(isValidGtin("012345678905"), true);   // UPC-A canonical
  assert.equal(isValidGtin("96385074"), true);       // EAN-8
  assert.equal(isValidGtin("4006381333932"), false); // bad check digit
  assert.equal(isValidGtin("012345678906"), false);  // bad check digit
});

test("isValidGtin passes non-GTIN (alphanumeric SKU) codes", () => {
  assert.equal(isValidGtin("BEV-0001"), true);
  assert.equal(isValidGtin("12345"), true); // 5 digits — not a GTIN length
});

/* ─── Normalization ────────────────────────────────────────── */

test("normalizeScannedCode strips AIM symbology prefixes", () => {
  assert.equal(normalizeScannedCode("]C1 4006381333931"), "4006381333931");
  assert.equal(normalizeScannedCode("]e04006381333931"), "4006381333931");
  assert.equal(normalizeScannedCode("]Q3sku:XYZ-1"), "sku:XYZ-1");
});

test("normalizeScannedCode strips whitespace", () => {
  assert.equal(normalizeScannedCode(" 4006 3813 33931 "), "4006381333931");
});

test("normalizeScannedCode preserves alphanumeric SKUs", () => {
  assert.equal(normalizeScannedCode("BEV-0001"), "BEV-0001");
});

test("normalizeScannedCode extracts GTIN from GS1 AI(01) string with batch", () => {
  // AI(01) 14-digit GTIN + AI(10) batch "ABC123"
  assert.equal(normalizeScannedCode("010400638133393110ABC123"), "4006381333931");
});

test("normalizeScannedCode picks the GTIN segment from GS-separated payloads", () => {
  assert.equal(normalizeScannedCode("4006381333931\u001d10ABC123"), "4006381333931");
});

test("normalizeScannedCode handles empty input", () => {
  assert.equal(normalizeScannedCode(""), "");
  assert.equal(normalizeScannedCode("   "), "");
});

/* ─── GTIN reduction ───────────────────────────────────────── */

test("normalizeGtin reduces GTIN-14 to minimal form", () => {
  // ≥2 leading zeros → UPC-A minimal form (N3–N14)
  assert.equal(normalizeGtin("00012345678905"), "012345678905");
  assert.equal(normalizeGtin("00400638133393"), "400638133393");
  // 000000 prefix → UPC-E/EAN-8 short code
  assert.equal(normalizeGtin("00000096385074"), "96385074");
  // non-0 indicator stays as-is
  assert.equal(normalizeGtin("10040063813393"), "10040063813393");
});

test("normalizeGtin keeps 13-digit codes that start with non-zero", () => {
  assert.equal(normalizeGtin("4006381333931"), "4006381333931");
});

/* ─── Candidates ───────────────────────────────────────────── */

test("barcodeCandidates expands UPC-A to EAN-13 and GTIN-14 forms", () => {
  const c = barcodeCandidates("012345678905");
  assert.ok(c.includes("012345678905"));
  assert.ok(c.includes("0012345678905".slice(1))); // 012345678905
  assert.ok(c.includes("0012345678905"));          // GTIN-14 form
  assert.deepEqual(c, [...new Set(c)]);            // deduplicated
});

test("barcodeCandidates expands 0-prefixed EAN-13 to UPC-A", () => {
  const c = barcodeCandidates("0012345678905");
  assert.ok(c.includes("012345678905"));
});

test("barcodeCandidates keeps alphanumeric SKU as single candidate", () => {
  assert.deepEqual(barcodeCandidates("BEV-0001"), ["BEV-0001"]);
});

test("barcodeCandidates handles empty input", () => {
  assert.deepEqual(barcodeCandidates(""), []);
});

/* ─── 2D payload extraction ────────────────────────────────── */

test("extractProductCode reads GS1 AI(01) QR payloads", () => {
  assert.equal(extractProductCode("0104006381333931"), "4006381333931");
  assert.equal(extractProductCode("0204006381333931370101"), "4006381333931"); // + AI(17) date
});

test("extractProductCode reads labelled codes", () => {
  assert.equal(extractProductCode("sku:BEV-0001"), "BEV-0001");
  assert.equal(extractProductCode("BARCODE:012345678905"), "012345678905");
});

test("extractProductCode reads URL query params", () => {
  assert.equal(extractProductCode("https://store.example.com/pos?barcode=012345678905"), "012345678905");
  assert.equal(extractProductCode("https://store.example.com/p/BEV-0001"), "BEV-0001");
});

test("extractProductCode falls back to plain normalization", () => {
  assert.equal(extractProductCode("BEV-0001"), "BEV-0001");
});

/* ─── Full pipeline ────────────────────────────────────────── */

test("parseScan maps raw camera output to lookup candidates", () => {
  const c = parseScan("]e04006381333931");
  assert.equal(c[0], "4006381333931");
  assert.ok(c.length >= 1);
  const upc = parseScan("0012345678905");
  assert.ok(upc.includes("012345678905"));
});
