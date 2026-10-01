/* ═══════════════════════════════════════════════════════════════
   PURCHASE ORDER MATH — unit tests
   Locks the line/header pricing rule shared by POST
   /api/purchase-orders (which used to compute it twice in one
   handler) and the PO CSV importer.
   Run: npx tsx --test tests/purchase-order-math.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { poLineTotals, poTotals } from "@/lib/suppliers/purchase-order-math";

test("poLineTotals: quantity × unitCost, tax on the line", () => {
  assert.deepEqual(poLineTotals({ quantity: 3, unitCost: 250, taxRate: 10 }), {
    lineTotal: 750,
    lineTax: 75,
    lineTotalWithTax: 825,
  });
});

test("poLineTotals: missing tax rate is zero, not NaN", () => {
  assert.deepEqual(poLineTotals({ quantity: 2, unitCost: 500 }), {
    lineTotal: 1000,
    lineTax: 0,
    lineTotalWithTax: 1000,
  });
  assert.equal(poLineTotals({ quantity: 2, unitCost: 500, taxRate: 0 }).lineTax, 0);
});

test("poLineTotals: fractional (weighed) quantities round to cents", () => {
  // 0.385 kg × 199¢ = 76.615 → 77¢; 5% of 77¢ = 3.85 → 4¢.
  assert.deepEqual(poLineTotals({ quantity: 0.385, unitCost: 199, taxRate: 5 }), {
    lineTotal: 77,
    lineTax: 4,
    lineTotalWithTax: 81,
  });
});

test("poTotals: sums lines and adds shipping to the total only", () => {
  const totals = poTotals(
    [
      { quantity: 3, unitCost: 250, taxRate: 10 },
      { quantity: 1, unitCost: 1000, taxRate: 0 },
    ],
    450
  );
  assert.deepEqual(totals, {
    subtotal: 1750,
    taxAmount: 75,
    shippingCost: 450,
    total: 2275,
  });
});

test("poTotals: no shipping when omitted (the CSV importer's case)", () => {
  const totals = poTotals([{ quantity: 2, unitCost: 300, taxRate: 0 }]);
  assert.equal(totals.shippingCost, 0);
  assert.equal(totals.total, 600);
});

test("poTotals: header tax equals the sum of the stored line taxes", () => {
  // The invariant that makes the PO header agree with its own lines:
  // tax is charged on each ROUNDED line amount, never on the raw product.
  const lines = [
    { quantity: 0.5, unitCost: 101, taxRate: 10 }, // 50.5 → 51, tax 5.1 → 5
    { quantity: 0.5, unitCost: 101, taxRate: 10 }, // 50.5 → 51, tax 5.1 → 5
  ];
  const header = poTotals(lines);
  const lineTaxSum = lines.reduce((sum, l) => sum + poLineTotals(l).lineTax, 0);
  assert.equal(header.taxAmount, lineTaxSum);
  assert.equal(header.subtotal, 102);
  assert.equal(header.taxAmount, 10);
  assert.equal(header.total, 112);
});

test("poTotals: empty order yields zeroes, shipping included", () => {
  assert.deepEqual(poTotals([]), {
    subtotal: 0,
    taxAmount: 0,
    shippingCost: 0,
    total: 0,
  });
  assert.equal(poTotals([], 900).total, 900);
});
