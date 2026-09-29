/* ═══════════════════════════════════════════════════════════════
   CART MATH — unit tests
   Locks the POS money rules: percentage vs fixed discounts, tax on the
   discounted amount, fractional-quantity handling, item counting and
   rounding consistency between line totals and cart totals.
   Run: npx tsx --test tests/cart-math.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineTotals,
  refreshLineTotals,
  calculateCartTotals,
} from "@/lib/cart-math";
import type { CartItem } from "@/types";

function cartItem(overrides: Partial<CartItem>): CartItem {
  return {
    id: "i1",
    productId: "p1",
    productName: "Test",
    sku: "SKU1",
    quantity: 1,
    unitPrice: 1000, // $10.00
    costPrice: 500,
    discountType: "percentage",
    discountValue: 0,
    discountAmount: 0,
    taxRate: 0,
    taxAmount: 0,
    total: 0,
    ...overrides,
  };
}

test("plain line: no discount, no tax", () => {
  const t = lineTotals(cartItem({ quantity: 2, unitPrice: 1000 }), 0);
  assert.deepEqual(t, { discountAmount: 0, taxAmount: 0, total: 2000 });
});

test("percentage discount rounds to the cent", () => {
  // $10.00 at 10% off = $9.00
  const t = lineTotals(cartItem({ unitPrice: 1000, discountType: "percentage", discountValue: 10 }), 0);
  assert.deepEqual(t, { discountAmount: 100, taxAmount: 0, total: 900 });
});

test("fixed discount scales with quantity", () => {
  // $0.50 off per unit × 3 = $1.50 off a $6.00 subtotal
  const t = lineTotals(
    cartItem({ quantity: 3, unitPrice: 2000, discountType: "fixed", discountValue: 50 }),
    0
  );
  assert.deepEqual(t, { discountAmount: 150, taxAmount: 0, total: 5850 });
});

test("tax applies after the discount", () => {
  // $10.00 − 10% = $9.00, taxed 5% → 45¢ tax, $9.45 total
  const t = lineTotals(
    cartItem({ unitPrice: 1000, discountType: "percentage", discountValue: 10 }),
    5
  );
  assert.deepEqual(t, { discountAmount: 100, taxAmount: 45, total: 945 });
});

test("discount can never push a line below zero", () => {
  // 100% discount → $0.00, tax on $0 stays $0
  const t = lineTotals(cartItem({ unitPrice: 1000, discountType: "percentage", discountValue: 100 }), 10);
  assert.deepEqual(t, { discountAmount: 1000, taxAmount: 0, total: 0 });
});

test("fractional quantity math (0.385 kg at $6/kg)", () => {
  // 0.385 × 600 = 231¢ subtotal → 10% discount = 23.1 → round 23
  const t = lineTotals(
    cartItem({ quantity: 0.385, unitPrice: 600, discountType: "percentage", discountValue: 10 }),
    0
  );
  assert.deepEqual(t, { discountAmount: 23, taxAmount: 0, total: 208 });
});

test("cart totals sum lines and total = subtotal − discount + tax", () => {
  const items = [
    cartItem({ id: "a", quantity: 1, unitPrice: 1000, discountValue: 10 }), // 900 after 10% off
    cartItem({ id: "b", quantity: 2, unitPrice: 500 }), // 1000 plain
  ];
  const totals = calculateCartTotals(items, 5); // 5% on everything
  assert.equal(totals.subtotal, 2000);
  assert.equal(totals.discountAmount, 100);
  assert.equal(totals.taxAmount, 95); // round(900×0.05) + round(1000×0.05)
  assert.equal(totals.total, 2000 - 100 + 95);
});

test("itemCount counts fractional lines as one, whole lines by quantity", () => {
  const items = [
    cartItem({ id: "a", quantity: 0.385, unitPrice: 600 }),
    cartItem({ id: "b", quantity: 2, unitPrice: 500 }),
    cartItem({ id: "c", quantity: 3, unitPrice: 250 }),
  ];
  assert.equal(calculateCartTotals(items, 0).itemCount, 1 + 2 + 3);
});

test("refreshLineTotals overwrites stale stored totals", () => {
  const stale = cartItem({ quantity: 1, unitPrice: 1000, total: 99999, discountAmount: 99999 });
  const [fresh] = refreshLineTotals([stale], 0);
  assert.ok(fresh, "refreshLineTotals keeps the row");
  assert.equal(fresh.total, 1000);
  assert.equal(fresh.discountAmount, 0);
  assert.equal(fresh.taxAmount, 0);
});

test("empty cart is all zeros", () => {
  const totals = calculateCartTotals([], 10);
  assert.deepEqual(totals, {
    subtotal: 0,
    taxAmount: 0,
    discountAmount: 0,
    total: 0,
    itemCount: 0,
  });
});

test("rounding never drifts between line and cart totals", () => {
  // Sum of per-line totals must equal the cart total whenever the cart
  // total = subtotal − Σdiscount + Σtax (all lines rounded identically).
  const items = [
    cartItem({ id: "a", quantity: 3, unitPrice: 199, discountValue: 7 }),
    cartItem({ id: "b", quantity: 0.75, unitPrice: 999, discountValue: 12 }),
    cartItem({ id: "c", quantity: 1, unitPrice: 4500, discountType: "fixed", discountValue: 100 }),
  ];
  const totals = calculateCartTotals(items, 8);
  const lineSum = items.reduce((acc, it) => acc + lineTotals(it, 8).total, 0);
  assert.equal(lineSum, totals.total);
});
