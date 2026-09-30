/* ═══════════════════════════════════════════════════════════════
   BARCODE UTILITIES
   Shared parsing layer for every scan source — camera (BarcodeDetector
   or ZXing), USB/Bluetooth hardware scanners (keyboard wedge), and
   manual typing.

   Responsibilities:
   - Normalize raw scanner output (strip AIM Symbology Identifier
     prefixes like ]C1 / ]e0 / ]Q3, GS1 separators, whitespace).
   - Extract product codes from rich 2D payloads (QR / DataMatrix):
     GS1 AI strings (01/02), "product:"/"sku:"/"barcode:" labels,
     URLs with ?barcode=/&sku= params, and bare codes.
   - Validate EAN-13/EAN-8/UPC-A/GTIN-14 check digits so a misread
     can be rejected client-side before hitting the API.
   - Produce tolerant lookup candidates (UPC-A ↔ EAN-13 ↔ GTIN-14
     zero-pad variants) so a product saved as "012345678905" still
     matches a scan of "12345678905" and vice versa.
   ═══════════════════════════════════════════════════════════════ */

/** GS1 group/record separators (control chars + their visual glyphs). */
const GS_CHARS = /[\u001d\u001e\u0004\u241d\u241e]/g;

/** AIM Symbology Identifier prefix: "]C1 ", "]e0", "]Q3", "]d2", … */
const SYMBOLOGY_PREFIX = /^\][A-Za-z][0-9A-Za-z]\s?/;

/**
 * Normalize a raw scanned value into a clean product code.
 * Preserves alphanumeric SKUs (e.g. "BEV-0001") while cleaning the
 * noise hardware readers and GS1 payloads add around real codes.
 */
export function normalizeScannedCode(raw: string): string {
  let v = (raw ?? "").trim();
  if (!v) return "";

  // Some readers prepend the AIM Symbology Identifier, e.g.
  // ]C1 for Code128, ]e0 for EAN/UPC, ]Q3 for QR — strip it.
  v = v.replace(SYMBOLOGY_PREFIX, "");

  // GS1 2D codes embed group separators (GS/RS). Split on them and
  // keep the segment that looks like a bare product code; the AI
  // rule below handles full AI(01) strings.
  v = v.replace(GS_CHARS, "\u001d");
  if (v.includes("\u001d")) {
    const segs = v.split("\u001d").map((s) => s.trim()).filter(Boolean);
    v = segs.find((s) => /^\d{6,14}$/.test(s)) ?? segs[0] ?? v;
  }

  v = v.replace(/\s+/g, "");

  // GS1 AI (01)/(02) fixed-length GTIN, optionally followed by AI(10)
  // batch / (21) serial / (11) date / (17) expiry / (37) count — e.g.
  // "010400638133393110ABC123" → GTIN 04006381333931.
  const gtinAi = v.match(/^0[12](\d{14})(?:\u001d|10|21|11|17|37|$)/);
  if (gtinAi) v = normalizeGtin(gtinAi[1]!);

  return v;
}

/**
 * Reduce a GTIN-family code to its minimal digit form:
 * GTIN-14 → EAN-13 / UPC-A / UPC-E, EAN-13 (0-prefixed) → UPC-A.
 */
export function normalizeGtin(gtin: string): string {
  const d = gtin.replace(/\D/g, "");
  if (d.length === 14) {
    // GS1 zero-suppression: N1–N6 = 000000 → UPC-E/EAN-8 carrier;
    // N1–N2 = 00 → UPC-A carrier; N1 = 0 → EAN-13 carrier.
    if (d.startsWith("000000")) return d.slice(6); // UPC-E / EAN-8 in GTIN-14
    if (d.startsWith("00")) return d.slice(2);     // UPC-A in GTIN-14
    if (d.startsWith("0")) return d.slice(1);      // EAN-13 in GTIN-14
    return d;
  }
  if (d.length === 13 && d.startsWith("0")) return d.slice(1); // UPC-A in EAN-13
  return d;
}

/** GS1 Application Identifier (01)/(02) extraction from a GS1 string. */
export function extractGtinFromGs1(value: string): string | null {
  const m = value.match(/^(?:\u001d)?0[12](\d{14})/);
  return m ? normalizeGtin(m[1]!) : null;
}

/**
 * Mod-10 check digit for the GTIN family (EAN-8 / UPC-A / EAN-13 /
 * GTIN-14). Accepts the PAYLOAD (code without its check digit) and
 * weights digits 3,1,3,1… from the right — the universal GTIN rule.
 */
export function gtinCheckDigit(payload: string): number {
  const d = payload.replace(/\D/g, "");
  const L = d.length + 1; // full code length including the check digit
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    // 1-based position from the right; check digit occupies position 1.
    const posFromRight = L - i;
    sum += Number(d[i]) * (posFromRight % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Validate a GTIN-family code's check digit. Codes whose length isn't
 * a GTIN length (alphanumeric SKUs etc.) pass — the check is only
 * meaningful for 8/12/13/14-digit numeric codes.
 */
export function isValidGtin(code: string): boolean {
  const d = code.replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(d.length)) return true; // not a GTIN — skip
  const payload = d.slice(0, -1);
  return gtinCheckDigit(payload) === Number(d[d.length - 1]);
}

/**
 * Candidate strings to search the catalog with, most-likely first.
 * Covers the UPC-A ↔ EAN-13 ↔ GTIN-14 zero-pad mismatches (a product
 * saved as "012345678905" must match a scan of "12345678905").
 * Deduplicated and order-stable.
 */
export function barcodeCandidates(code: string): string[] {
  const base = normalizeScannedCode(code);
  if (!base) return [];
  const out: string[] = [base];
  if (/^\d+$/.test(base)) {
    if (base.length === 12) {
      out.push("0" + base);   // UPC-A → EAN-13 form
      out.push("00" + base);  // UPC-A → GTIN-14 form
    } else if (base.length === 13) {
      if (base.startsWith("0")) out.push(base.slice(1)); // EAN-13 → UPC-A
      else out.push("0" + base);                          // EAN-13 → GTIN-14
    } else if (base.length === 14) {
      const minimal = normalizeGtin(base); // GTIN-14 → minimal form
      if (minimal !== base) out.push(minimal);
      // A 12-digit minimal form (UPC-A) must also match products saved
      // with the 13-digit zero-padded EAN-13 representation.
      if (minimal.length === 12) out.push("0" + minimal);
    } else if (base.length === 8) {
      out.push("000000" + base); // EAN-8 → GTIN-14 form
    }
  }
  return [...new Set(out.filter(Boolean))];
}

/* ─── Embedded weight/price barcodes (GS1 local AIs) ────────────
   Prefix-based in-store codes that carry quantity or price inside
   the barcode: 28/29 = weight (kg), 31/32 = weight variants,
   22 = price in some regions. Configuration (prefix, item-code
   length, value length, decimals, value type) lives in Settings;
   parsing here is pure integer math — no floats. */

export interface EmbeddedBarcodeConfig {
  /** Barcode prefix, e.g. "28" for in-store weight labels. */
  prefix: string;
  /** Digits of the embedded item code after the prefix. */
  itemCodeLength: number;
  /** Digits of the embedded value field (before the check digit). */
  valueLength: number;
  /** Decimal places of the value (2 → value/100). */
  decimals: number;
  /** What the embedded value means. */
  valueType: "weight" | "price";
}

export interface EmbeddedBarcodeData {
  /** The embedded item/product code to look up. */
  itemCode: string;
  /** Value in smallest units, exactly as encoded (grams for weight
   *  per the configured decimals, cents for price). "00150" @ 3
   *  decimals → 150; "01250" @ 2 decimals → 1250. */
  value: number;
  valueType: "weight" | "price";
  /** The remaining barcode (prefix + item code) for lookup. */
  lookupCode: string;
}

/**
 * Parse an embedded weight/price barcode against a config.
 * Expected layout: PREFIX + ITEM_CODE + VALUE + CHECK_DIGIT.
 * Validates the GTIN check digit when the total length is a GTIN
 * length; integer parsing throughout ("00150" @2 decimals → 150).
 * Returns null when the code does not match the config shape.
 */
export function parseEmbeddedBarcode(
  code: string,
  config: EmbeddedBarcodeConfig
): EmbeddedBarcodeData | null {
  const d = (code ?? "").replace(/\D/g, "");
  if (!config.prefix || !d.startsWith(config.prefix)) return null;
  const itemStart = config.prefix.length;
  const valueStart = itemStart + config.itemCodeLength;
  const checkIndex = valueStart + config.valueLength;
  // Must be exactly prefix+item+value (+ optional check digit).
  if (d.length !== checkIndex && d.length !== checkIndex + 1) return null;

  // The store-generated EAN-13s pass through gtinCheckDigit; labels
  // without a GTIN length (e.g. 8-digit local codes) skip the check.
  if ([8, 12, 13, 14].includes(d.length) && !isValidGtin(d)) return null;

  const itemCode = d.slice(itemStart, valueStart);
  const rawValue = d.slice(valueStart, checkIndex);
  if (!itemCode || !rawValue) return null;
  // The raw field IS the value in smallest units: "00150" @ 3 decimals
  // means 150 g, "01250" @ 2 decimals means 1250 cents. Integer parse
  // of the whole field — no float arithmetic anywhere.
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;
  return {
    itemCode,
    value,
    valueType: config.valueType,
    lookupCode: config.prefix + itemCode,
  };
}

/* ─── GTIN-13 (EAN-13) generation ───────────────────────────── */

/**
 * Generate a valid, unique-in-store EAN-13 for products that have no
 * manufacturer barcode (house-branded goods, produce, in-house packs).
 *
 * Shape: `200` + store prefix (up to 3 digits) + 9 random digits, with
 * the mod-10 check digit computed on top — the `200–299` band is the
 * GS1-reserved range for IN-STORE codes, guaranteed to never collide
 * with a real manufacturer GTIN. Fully valid & scannable: any retail
 * scanner reads it, and isValidGtin() passes.
 */
export function generateEan13(storePrefix = ""): string {
  const prefixDigits = storePrefix.replace(/\D/g, "").slice(0, 3);
  const body = ("200" + prefixDigits).padEnd(6, "0").slice(0, 6) +
    String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0").slice(0, 6);
  // body is 12 digits: "200" + prefix(≤3, padded) → 6, + 6 random
  return body + String(gtinCheckDigit(body));
}

/* ─── 2D payload (QR / DataMatrix) parsing ──────────────────── */

/**
 * Extract a product code from a rich QR/DataMatrix payload.
 * Understands:
 *  - GS1 AI strings:            0104006381333931 · 02040063813339313710ABC
 *  - Labelled codes:            product:XYZ · sku:XYZ · barcode:XYZ · code:XYZ
 *  - POS deep links / URLs:     /pos?q=XYZ ?barcode=XYZ &upc=XYZ
 *  - Plain text:                returned normalized as-is
 */
export function extractProductCode(raw: string): string {
  const v = (raw ?? "").trim();
  if (!v) return "";

  // GS1 AI string (01) or (02) — including embedded GS separators.
  const gs1 = extractGtinFromGs1(v.replace(GS_CHARS, ""));
  if (gs1) return gs1;

  // Labelled single codes: sku:ABC-123, barcode:012345678905, …
  const labelled = v.match(/^(?:product|sku|barcode|code|upc|ean)\s*[:=]\s*(\S+)$/i);
  if (labelled) return normalizeScannedCode(labelled[1]!);

  // URLs — pull the product code out of a query param if present.
  if (/^https?:\/\//i.test(v) || v.startsWith("/")) {
    try {
      const url = new URL(v, "https://pos.local");
      for (const key of ["barcode", "upc", "ean", "sku", "code", "q"]) {
        const val = url.searchParams.get(key);
        if (val) return normalizeScannedCode(val);
      }
      // Fall back to the last meaningful path segment (e.g. /p/ABC-123)
      const seg = url.pathname.split("/").filter(Boolean).pop();
      if (seg && !/^(pos|products?|p)$/i.test(seg)) return normalizeScannedCode(seg);
    } catch {
      /* not a URL after all */
    }
  }

  return normalizeScannedCode(v);
}

/**
 * Full pipeline: raw scan → product code candidates. This is the one
 * entry point UI code should call for anything a scanner emitted.
 */
export function parseScan(raw: string): string[] {
  return barcodeCandidates(extractProductCode(raw));
}
