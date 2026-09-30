/* ═══════════════════════════════════════════════════════════════
   PAYMENT MATH — unit tests
   Locks the partial-payment (khata) rules shared by the POS payment
   dialog, the checkout service and the customers-page settlement.
   Run: npx tsx --test tests/payment-math.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePayment,
  isPartialPaymentAllowed,
  allocateSettlement,
  orderStatusAfterSettlement,
} from "@/lib/money/payment-math";

test("full payment: no due, no change beyond overpayment", () => {
  const r = resolvePayment(2000, 2000, true);
  assert.deepEqual(r, {
    collected: 2000,
    dueAmount: 0,
    changeDue: 0,
    paymentStatus: "paid",
    isCreditSale: false,
  });
});

test("overpayment: change returned, nothing to credit", () => {
  const r = resolvePayment(1850, 2000, false);
  assert.equal(r.changeDue, 150);
  assert.equal(r.dueAmount, 0);
  assert.equal(r.paymentStatus, "paid");
  assert.equal(r.isCreditSale, false);
});

test("underpayment with customer becomes credit (partial)", () => {
  const r = resolvePayment(2000, 1200, true);
  assert.deepEqual(r, {
    collected: 1200,
    dueAmount: 800,
    changeDue: 0,
    paymentStatus: "partial",
    isCreditSale: true,
  });
});

test("zero payment with customer is unpaid credit", () => {
  const r = resolvePayment(1500, 0, true);
  assert.equal(r.dueAmount, 1500);
  assert.equal(r.paymentStatus, "unpaid");
  assert.equal(r.isCreditSale, true);
});

test("underpayment without customer is not a credit sale", () => {
  const r = resolvePayment(2000, 500, false);
  assert.equal(r.isCreditSale, false);
  assert.equal(r.paymentStatus, "unpaid");
  assert.equal(r.dueAmount, 1500);
});

test("partial payment only allowed with a customer", () => {
  assert.equal(isPartialPaymentAllowed(true), true);
  assert.equal(isPartialPaymentAllowed(false), false);
});

test("settlement allocates oldest-due-first (FIFO)", () => {
  const { allocations, leftover } = allocateSettlement(
    [
      { id: "new", dueAmount: 500, createdAt: "2026-01-10" },
      { id: "old", dueAmount: 700, createdAt: "2026-01-01" },
    ],
    1000
  );
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0]!.orderId, "old");
  assert.equal(allocations[0]!.amount, 700);
  assert.equal(allocations[0]!.fullySettled, true);
  assert.equal(allocations[1]!.orderId, "new");
  assert.equal(allocations[1]!.amount, 300);
  assert.equal(allocations[1]!.fullySettled, false);
  assert.equal(leftover, 0);
});

test("settlement with overpay leaves advance leftover", () => {
  const { allocations, leftover } = allocateSettlement(
    [{ id: "a", dueAmount: 400, createdAt: "2026-01-01" }],
    900
  );
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0]!.amount, 400);
  assert.equal(leftover, 500);
});

test("settlement skips zero-due orders", () => {
  const { allocations } = allocateSettlement(
    [
      { id: "settled", dueAmount: 0, createdAt: "2026-01-01" },
      { id: "open", dueAmount: 250, createdAt: "2026-01-02" },
    ],
    1000
  );
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0]!.orderId, "open");
});

test("order status after settlement: paid at total, partial below", () => {
  assert.equal(orderStatusAfterSettlement(1000, 600, 400), "paid");
  assert.equal(orderStatusAfterSettlement(1000, 300, 400), "partial");
  assert.equal(orderStatusAfterSettlement(1000, 0, 0), "unpaid");
});
