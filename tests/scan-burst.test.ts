/* ═══════════════════════════════════════════════════════════════
   SCAN BURST + EMBEDDED BARCODES — unit tests
   Pure-logic coverage of the global scan handler's building blocks
   (the hook itself is DOM-bound; the burst state machine and the
   embedded-barcode parser are the testable core):
   - charFromEventCode maps physical keys layout-independently
     (Urdu keyboard: event.code "KeyA" still means "a")
   - embedded weight/price barcodes parse by integer math with check
     digits, configured prefix/item/value/decimals
   Run: npx tsx --test tests/scan-burst.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { charFromEventCode } from "@/hooks/use-scan-input";
import { parseEmbeddedBarcode } from "@/lib/products/barcode";
import { gtinCheckDigit } from "@/lib/products/barcode";

/* ─── event.code fallback (Urdu keyboard layouts) ─────────────── */

function fakeEvent(partial: { code?: string; key: string }): KeyboardEvent {
  return partial as unknown as KeyboardEvent;
}

test("KeyA..KeyZ and Digit0..9 map to layout-independent characters", () => {
  assert.equal(charFromEventCode(fakeEvent({ code: "KeyA", key: "ش" })), "a");
  assert.equal(charFromEventCode(fakeEvent({ code: "KeyZ", key: "ژ" })), "z");
  assert.equal(charFromEventCode(fakeEvent({ code: "Digit4", key: "۴" })), "4");
  assert.equal(charFromEventCode(fakeEvent({ code: "Numpad7", key: "۷" })), "7");
});

test("unmapped codes yield empty (caller falls back to e.key)", () => {
  assert.equal(charFromEventCode(fakeEvent({ code: "ShiftLeft", key: "Shift" })), "");
  assert.equal(charFromEventCode(fakeEvent({ key: "Enter" })), "");
});

/* ─── Embedded weight/price barcodes ──────────────────────────── */

const WEIGHT_CFG = {
  prefix: "28",
  itemCodeLength: 5,
  valueLength: 5,
  decimals: 3, // the 5-digit field IS grams: 00150 → 150 g
  valueType: "weight" as const,
};

const PRICE_CFG = {
  prefix: "22",
  itemCodeLength: 5,
  valueLength: 5,
  decimals: 2, // the 5-digit field IS cents: 01250 → Rs 12.50
  valueType: "price" as const,
};

test("embedded weight barcode: prefix+item+value with check digit", () => {
  // 28 + 00042 + 00150 + check → build the check digit for a 13-digit code.
  const body = "280004200150";
  const code = body + String(gtinCheckDigit(body));
  const parsed = parseEmbeddedBarcode(code, WEIGHT_CFG);
  assert.ok(parsed);
  assert.equal(parsed!.itemCode, "00042");
  assert.equal(parsed!.value, 150, "00150 @ 3 decimals → 150 g");
  assert.equal(parsed!.valueType, "weight");
  assert.equal(parsed!.lookupCode, "2800042", "prefix + item code for lookup");
});

test("embedded price barcode: integer math, no floats", () => {
  const body = "220000701250";
  const code = body + String(gtinCheckDigit(body));
  const parsed = parseEmbeddedBarcode(code, PRICE_CFG);
  assert.ok(parsed);
  assert.equal(parsed!.itemCode, "00007");
  assert.equal(parsed!.value, 1250, "the raw field 01250 → 1250 cents, unrounded");
  assert.equal(parsed!.valueType, "price");
});

test("barcode without a check digit is accepted when shape matches", () => {
  // 12 digits — not a GTIN length, so no check digit required.
  const parsed = parseEmbeddedBarcode("280004200150", WEIGHT_CFG);
  assert.ok(parsed);
  assert.equal(parsed!.value, 150);
});

test("wrong prefix → null; bad check digit → null; wrong length → null", () => {
  const body = "280004200150";
  const good = body + String(gtinCheckDigit(body));
  assert.equal(parseEmbeddedBarcode("99" + good.slice(2), WEIGHT_CFG), null, "prefix mismatch");
  const badDigit = body + String((gtinCheckDigit(body) + 1) % 10);
  assert.equal(parseEmbeddedBarcode(badDigit, WEIGHT_CFG), null, "bad check digit");
  assert.equal(parseEmbeddedBarcode("2800042150", WEIGHT_CFG), null, "value field too short");
});

test("non-numeric garbage never parses", () => {
  assert.equal(parseEmbeddedBarcode("BEV-0001", WEIGHT_CFG), null);
  assert.equal(parseEmbeddedBarcode("", WEIGHT_CFG), null);
});
