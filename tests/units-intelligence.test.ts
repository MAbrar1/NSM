/* ═══════════════════════════════════════════════════════════════
   MULTI-UNIT INTELLIGENCE — unit tests
   Locks the pricing-tier engine, comparable unit prices, smart pack
   breakdowns, reorder intelligence and quantity snapping.
   Run: npx tsx --test tests/units-intelligence.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTierPrice,
  nextTierNudge,
  comparableUnitPrice,
  planPackBreakdown,
  reorderAdvice,
  snapQuantity,
  type PriceTier,
} from "@/lib/units-intelligence";

/* Sugar: base kg @ Rs 130; bulk tiers in kg and g units. The half-kg
   tier is expressed as a 1500 g minimum so it only applies above the
   5 kg tier's reach being tested distinctly below. */
const TIERS: PriceTier[] = [
  { minQty: 5, unit: "kg", unitPriceCents: 12_000, label: "5 kg sack" },        // Rs 120/kg
  { minQty: 7500, unit: "g", unitPriceCents: 11_500, label: "7.5 kg club" },    // 7.5 kg → Rs 115/kg
  { minQty: 10, unit: "kg", unitPriceCents: 11_000, label: "Bulk 10+" },        // Rs 110/kg
];

test("tier price: quantity in g converts and the deepest qualifying tier wins", () => {
  // 6000 g = 6 kg → qualifies for the 5 kg tier (12000), not 7.5 kg/10 kg.
  const r = resolveTierPrice(6000, "g", "kg", 13_000, TIERS);
  assert.equal(r.unitPriceCents, 12_000);
  assert.equal(r.tier!.label, "5 kg sack");
  assert.equal(r.savingsVsBase, 1_000);
});

test("tier price: below every tier falls back to the base price", () => {
  const r = resolveTierPrice(2, "kg", "kg", 13_000, TIERS);
  assert.equal(r.unitPriceCents, 13_000);
  assert.equal(r.tier, null);
  assert.equal(r.savingsVsBase, 0);
});

test("tier price: 12 kg hits the bulk tier", () => {
  const r = resolveTierPrice(12, "kg", "kg", 13_000, TIERS);
  assert.equal(r.unitPriceCents, 11_000);
});

test("nextTierNudge: tells the shopper exactly how much more unlocks savings", () => {
  const nudge = nextTierNudge(3, "kg", "kg", TIERS);
  assert.ok(nudge);
  assert.equal(nudge!.unit, "kg");
  assert.equal(nudge!.remainingQty, 2, "3 → 5 kg");
  assert.match(nudge!.label, /5 kg/);
  const none = nextTierNudge(15, "kg", "kg", TIERS);
  assert.equal(none, null, "past every tier → no nudge");
});

test("comparableUnitPrice: 500 g pack vs 1 kg pack compare fairly", () => {
  // 500 g @ Rs 70 → Rs 140/kg; 1 kg @ Rs 130 → Rs 130/kg.
  const small = comparableUnitPrice(7_000, 0.5, "kg", "kg");
  const big = comparableUnitPrice(13_000, 1, "kg", "kg");
  assert.equal(small!.priceCents, 14_000);
  assert.equal(big!.priceCents, 13_000);
  assert.match(small!.label, /\/kg$/);
  // Grams normalize too: 250 g @ Rs 35 → Rs 140/kg.
  const grams = comparableUnitPrice(3_500, 250, "g", "kg");
  assert.equal(grams!.priceCents, 14_000);
});

test("comparableUnitPrice: liquids via ml→L and pcs stay per-pc", () => {
  const oil = comparableUnitPrice(45_000, 500, "ml", "L"); // 500 ml @ Rs 450 → Rs 900/L
  assert.equal(oil!.priceCents, 90_000);
  assert.equal(oil!.comparisonUnit, "L");
  // A dozen-egg pack @ Rs 24/dozen, base unit pcs → Rs 24 per pcs
  // (dozen has no built-in conversion, so the package IS 1 base unit).
  const eggs = comparableUnitPrice(2_400, 1, "dozen", "pcs");
  assert.equal(eggs!.priceCents, 2_400);
  assert.equal(eggs!.comparisonUnit, "pcs");
});

test("planPackBreakdown: fewest opens — 14 kg from 10/5/1 kg packs", () => {
  const plan = planPackBreakdown(14, [
    { packQty: 1, label: "1 kg" },
    { packQty: 5, label: "5 kg" },
    { packQty: 10, label: "10 kg" },
  ]);
  assert.deepEqual(
    plan.packs.map((p) => `${p.count}× ${p.spec.label}`),
    ["1× 10 kg", "4× 1 kg"]
  );
  assert.equal(plan.looseQty, 0);
});

test("planPackBreakdown: fractional remainder stays loose", () => {
  const plan = planPackBreakdown(7.5, [{ packQty: 5, label: "5 kg" }]);
  assert.equal(plan.packs[0]!.count, 1);
  assert.equal(plan.looseQty, 2.5);
});

test("reorderAdvice: deficit, days-of-cover and urgency", () => {
  const urgent = reorderAdvice(4, 10, 2, ["kg", "g"], 3);
  assert.equal(urgent.reorderBaseQty, 6);
  assert.equal(urgent.daysOfCover, 2);
  assert.equal(urgent.urgent, true, "2 days of cover < 3-day lead time");
  const healthy = reorderAdvice(50, 10, 2, ["kg"], 3);
  assert.equal(healthy.reorderBaseQty, 0);
  assert.equal(healthy.urgent, false);
  const noPace = reorderAdvice(4, 10, null, ["kg"], 3);
  assert.equal(noPace.daysOfCover, null);
  assert.equal(noPace.urgent, true, "deficit with no pace data still flags");
});

test("snapQuantity: whole units round up; scale steps round nearest; passthrough", () => {
  assert.deepEqual(snapQuantity(1.3, "pcs", null), { qty: 2, changed: true, reason: "whole-unit" });
  assert.deepEqual(snapQuantity(2, "pcs", null), { qty: 2, changed: false, reason: null });
  // 10 g scale on a kg product: 0.385 kg → 0.39? nearest step 0.39 → actually 0.39 vs 0.38…
  const stepped = snapQuantity(0.384, "kg", 0.01);
  assert.equal(stepped.qty, 0.38);
  assert.equal(stepped.reason, "step");
  const free = snapQuantity(0.385, "kg", null);
  assert.deepEqual(free, { qty: 0.385, changed: false, reason: null });
});
