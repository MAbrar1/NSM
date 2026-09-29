/* ═══════════════════════════════════════════════════════════════
   CHECKOUT TAMPERING & MONEY RULES — unit tests
   Locks the server-authoritative money enforcement of the POS
   checkout (lib/checkout-math — the exact code the API route runs):

   - forged client prices/costs/totals must be REJECTED, never stored
   - recomputed line/cart money matches the client's honest cart
   - loyalty redemption is capped by the real balance and by what is
     owed (1 point = 1 cent), never below zero
   - payment must cover the final total; change is server-derived
   - tolerance is exactly ±1 cent (float noise passes, tampering fails)
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MONEY_TOLERANCE,
  reconcileCheckoutLine,
  reconcileCartTotals,
  resolveLoyaltyRedemption,
  validatePayment,
  type ClientCheckoutLine,
  type ServerPricing,
} from "@/lib/checkout-math";

/** An honest line: $10.00 unit price, $6.00 cost, 5% tax. */
const SERVER: ServerPricing = { unitPrice: 1000, costPrice: 600, taxRate: 5 };

/**
 * Build the client-side mirror of an honest line for the given server
 * pricing — same recomputation rules as lib/cart-math.
 */
function honestLine(
  overrides: Partial<ClientCheckoutLine> = {},
  server: ServerPricing = SERVER
): ClientCheckoutLine {
  const quantity = overrides.quantity ?? 1;
  const unitPrice = overrides.unitPrice ?? server.unitPrice;
  const costPrice = overrides.costPrice ?? server.costPrice;
  const discountType = overrides.discountType;
  const discountValue = overrides.discountValue;
  const subtotal = unitPrice * quantity;
  const discount =
    discountType === "percentage"
      ? Math.round(subtotal * ((discountValue ?? 0) / 100))
      : (discountValue ?? 0) * quantity;
  const afterDiscount = Math.max(0, subtotal - discount);
  const tax = Math.round(afterDiscount * (server.taxRate / 100));
  return {
    unitPrice,
    costPrice,
    quantity,
    discountType,
    discountValue,
    discountAmount: discount,
    taxAmount: tax,
    total: Math.round(afterDiscount + tax),
    ...overrides,
  };
}

test("an honest line reconciles and yields the recomputed money", () => {
  const r = reconcileCheckoutLine(honestLine(), SERVER, "Widget");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.subtotal, 1000);
  assert.equal(r.discount, 0);
  assert.equal(r.taxAmount, 50); // 5% of $10
  assert.equal(r.total, 1050);
});

test("forged unit price is rejected (client claims $5 for a $10 product)", () => {
  const line = honestLine({ unitPrice: 500, total: 525, taxAmount: 25 });
  const r = reconcileCheckoutLine(line, SERVER, "Widget");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /price of Widget has changed/i);
});

test("forged cost price is rejected (underselling trick)", () => {
  const line = honestLine({ costPrice: 1 });
  const r = reconcileCheckoutLine(line, SERVER, "Widget");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /cost of Widget has changed/i);
});

test("forged line total is rejected even when the price matches", () => {
  const line = honestLine();
  line.total = 1; // keep unitPrice honest, lie about the line total
  const r = reconcileCheckoutLine(line, SERVER, "Widget");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /total for Widget no longer matches/i);
});

test("forged tax is rejected", () => {
  const line = honestLine();
  line.taxAmount = 0; // claim tax-free on a taxed product
  const r = reconcileCheckoutLine(line, SERVER, "Widget");
  assert.equal(r.ok, false);
});

test("forged discount is rejected", () => {
  // Start from an honestly-discounted line, then lie about the discount.
  const line = honestLine({ discountType: "percentage", discountValue: 10 });
  assert.equal(reconcileCheckoutLine(line, SERVER, "Widget").ok, true);
  line.discountAmount = 0; // silently drop the discount bookkeeping
  const r = reconcileCheckoutLine(line, SERVER, "Widget");
  assert.equal(r.ok, false);
});

test("quantity affects the recomputation, not the price check", () => {
  // 3 × $10 = $30, tax 5% = 150¢, total $31.50 — all derived from qty.
  const r = reconcileCheckoutLine(honestLine({ quantity: 3 }), SERVER, "Widget");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.subtotal, 3000);
  assert.equal(r.taxAmount, 150);
  assert.equal(r.total, 3150);
});

test("percentage discount on a fractional (weight) sale rounds to the cent", () => {
  // 0.385 kg at $6.00/kg = 231¢ subtotal; 10% → 23.1 → 23
  const server: ServerPricing = { unitPrice: 600, costPrice: 400, taxRate: 0 };
  const r = reconcileCheckoutLine(
    honestLine(
      { quantity: 0.385, unitPrice: 600, costPrice: 400, discountType: "percentage", discountValue: 10 },
      server
    ),
    server,
    "Sugar"
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.subtotal, 231);
  assert.equal(r.discount, 23);
  assert.equal(r.total, 208);
});

test("±1 cent float noise is tolerated, 2 cents is tampering", () => {
  const ok = honestLine();
  ok.total = 1050 + 1; // within tolerance
  assert.equal(reconcileCheckoutLine(ok, SERVER, "W").ok, true);

  const bad = honestLine();
  bad.total = 1050 + 2; // beyond tolerance
  assert.equal(reconcileCheckoutLine(bad, SERVER, "W").ok, false);

  assert.equal(MONEY_TOLERANCE, 1);
});

test("discount can never drive a line negative", () => {
  const r = reconcileCheckoutLine(
    honestLine({ discountType: "percentage", discountValue: 150 }),
    SERVER,
    "Widget"
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.total, 0); // base clamps at $0; tax on $0 is $0
});

test("cart totals must match the server's recomputation", () => {
  const ok = reconcileCartTotals(
    { subtotal: 2000, taxAmount: 100, discountAmount: 0, total: 2100 },
    { subtotal: 2000, taxAmount: 100, discountAmount: 0, total: 2100 }
  );
  assert.equal(ok.ok, true);

  const bad = reconcileCartTotals(
    { subtotal: 2000, taxAmount: 100, discountAmount: 0, total: 2100 },
    { subtotal: 2000, taxAmount: 100, discountAmount: 0, total: 2102 }
  );
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.error, /no longer match/i);
});

test("loyalty: redemption without a customer is rejected", () => {
  const r = resolveLoyaltyRedemption(50, 0, 1000, false);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /select a customer/i);
});

test("loyalty: more points than the balance is rejected", () => {
  const r = resolveLoyaltyRedemption(500, 100, 10_000, true);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /has 100 loyalty points, but 500 were requested/);
});

test("loyalty: redemption is capped at what is owed (never discounts below zero)", () => {
  // Customer has 5 000 points, order is only $10 — only 1 000 cents may burn.
  const r = resolveLoyaltyRedemption(5000, 5000, 1000, true);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.cents, 1000);
  assert.equal(r.points, 1000);
});

test("loyalty: zero or negative request is a no-op", () => {
  assert.deepEqual(resolveLoyaltyRedemption(0, 0, 1000, false), { ok: true, cents: 0, points: 0 });
  assert.deepEqual(resolveLoyaltyRedemption(-5, 100, 1000, true), { ok: true, cents: 0, points: 0 });
});

test("loyalty: 1 point burns as exactly 1 cent", () => {
  const r = resolveLoyaltyRedemption(250, 250, 5000, true);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.cents, 250);
  assert.equal(r.points, 250);
});

test("payment below the final total is rejected", () => {
  const r = validatePayment(900, 1000);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /less than the order total/i);
});

test("payment exactly covering the total yields zero change", () => {
  const r = validatePayment(1000, 1000);
  assert.deepEqual(r, { ok: true, changeDue: 0 });
});

test("change is derived from the payment, never trusted", () => {
  const r = validatePayment(2000, 1050);
  assert.deepEqual(r, { ok: true, changeDue: 950 });
});

test("loyalty discounts the payment requirement, not the recorded order total", () => {
  // Order $10.50, 50 points burned → must pay $10.00.
  const loyalty = resolveLoyaltyRedemption(50, 100, 1050, true);
  assert.equal(loyalty.ok, true);
  if (!loyalty.ok) return;
  const finalTotal = Math.max(0, 1050 - loyalty.cents);
  assert.equal(validatePayment(1000, finalTotal).ok, true);
  assert.equal(validatePayment(999, finalTotal).ok, false);
});
