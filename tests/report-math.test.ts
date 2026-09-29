/* ═══════════════════════════════════════════════════════════════
   REPORT MATH — unit tests
   Locks the COGS / valuation / profit / margin arithmetic shared by
   the profit-loss, sales and inventory report endpoints.
   Run: npx tsx --test tests/report-math.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineCogs,
  stockCostValue,
  stockRetailValue,
  netOf,
  marginPercent,
  averageOrderValue,
} from "@/lib/report-math";

test("lineCogs: cost captured at sale time × quantity", () => {
  assert.equal(lineCogs(250, 3), 750);
  assert.equal(lineCogs(199, 0.385), 76.615); // callers sum raw, then round
});

test("stock valuation: cost and retail value of a stock row", () => {
  assert.equal(stockCostValue(12, 250), 3000);
  assert.equal(stockRetailValue(12, 400), 4800);
  assert.equal(netOf(stockRetailValue(12, 400), stockCostValue(12, 250)), 1800);
});

test("netOf: one subtraction behind gross profit, net revenue and margin", () => {
  assert.equal(netOf(1000, 600), 400); // gross profit / potential profit
  assert.equal(netOf(1000, 150), 850); // net revenue after discounts
});

test("marginPercent: whole percent", () => {
  assert.equal(marginPercent(1000, 600), 40);
  assert.equal(marginPercent(1000, 0), 100);
  assert.equal(marginPercent(1000, 1000), 0);
});

test("marginPercent: zero revenue is 0, never NaN or Infinity", () => {
  assert.equal(marginPercent(0, 0), 0);
  assert.equal(marginPercent(0, 500), 0);
});

test("marginPercent: a loss reports a negative margin", () => {
  assert.equal(marginPercent(100, 150), -50);
});

test("averageOrderValue: rounded cents, zero without orders", () => {
  assert.equal(averageOrderValue(1000, 3), 333);
  assert.equal(averageOrderValue(0, 0), 0);
  assert.equal(averageOrderValue(5000, 0), 0);
});
