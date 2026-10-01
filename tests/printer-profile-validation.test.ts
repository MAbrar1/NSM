/* ═══════════════════════════════════════════════════════════════
   PRINTER PROFILE VALIDATION — unit tests
   Locks the physical rules: dots multiple of 8, dots consistent
   with width×dpi, band height alignment — and proves the three
   presets plus a custom 88 mm profile pass BY CONFIGURATION.
   Run: npx tsx --test tests/printer-profile-validation.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { printerProfileSchema, PRINTER_PRESETS } from "@/lib/validations/print";

function baseProfile(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test printer",
    paperWidthMm: 80,
    printableDots: 576,
    dpi: 203,
    charsPerLine: 48,
    ...overrides,
  };
}

test("80 mm profile at 576 dots / 203 dpi is valid", () => {
  const r = printerProfileSchema.safeParse(baseProfile());
  assert.equal(r.success, true);
});

test("printableDots must be a multiple of 8", () => {
  const r = printerProfileSchema.safeParse(baseProfile({ printableDots: 577 }));
  assert.equal(r.success, false);
});

test("printableDots inconsistent with width×dpi is rejected", () => {
  // 58 mm @ 203 dpi expects ≈464 dots; 576 is way off (that's the 80 mm head).
  const r = printerProfileSchema.safeParse(baseProfile({ paperWidthMm: 58, printableDots: 576 }));
  assert.equal(r.success, false);
});

test("bandHeight must also be a multiple of 8", () => {
  const r = printerProfileSchema.safeParse(baseProfile({ bandHeight: 250 }));
  assert.equal(r.success, false);
  const ok = printerProfileSchema.safeParse(baseProfile({ bandHeight: 256 }));
  assert.equal(ok.success, true);
});

test("drawer pin is strictly 2 or 5", () => {
  assert.equal(printerProfileSchema.safeParse(baseProfile({ drawerPin: 2 })).success, true);
  assert.equal(printerProfileSchema.safeParse(baseProfile({ drawerPin: 5 })).success, true);
  assert.equal(printerProfileSchema.safeParse(baseProfile({ drawerPin: 3 })).success, false);
});

test("58 mm preset (384 dots) passes by configuration", () => {
  const p = PRINTER_PRESETS.find((x) => x.name.startsWith("58"))!;
  const r = printerProfileSchema.safeParse({ ...p, charsPerLine: p.charsPerLine });
  assert.equal(r.success, true);
});

test("80 mm preset (576 dots) passes by configuration", () => {
  const p = PRINTER_PRESETS.find((x) => x.name.startsWith("80"))!;
  const r = printerProfileSchema.safeParse({ ...p });
  assert.equal(r.success, true);
});

test("112 mm preset (832 dots) passes by configuration", () => {
  const p = PRINTER_PRESETS.find((x) => x.name.startsWith("112"))!;
  const r = printerProfileSchema.safeParse({ ...p });
  assert.equal(r.success, true);
});

test("custom 88 mm profile (504 dots) passes by configuration — no code change", () => {
  // 88 mm @ 203 dpi → 88/25.4×203 ≈ 703.6 dots → round to a
  // multiple of 8 within ±15%: 704.
  const r = printerProfileSchema.safeParse(
    baseProfile({ name: "Custom 88 mm", paperWidthMm: 88, printableDots: 704, charsPerLine: 52 })
  );
  assert.equal(r.success, true);
});
