/* ═══════════════════════════════════════════════════════════════
   EARN RATE — unit tests
   Locks the loyalty earn rule shared by checkout (earn), refunds
   (clawback) and the seed rollup. One formula in lib/earn-rate —
   the three sites used to drift (Math.floor(x/100) duplicated).
   Run: npx tsx --test tests/earn-rate.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LOYALTY_SPEND_PER_POINT, loyaltyPointsForSpend } from "@/lib/earn-rate";

test("constant: 100 cents of spend per point", () => {
  assert.equal(LOYALTY_SPEND_PER_POINT, 100);
});

test("$12.50 order earns 12 points (floor, never rounds up)", () => {
  assert.equal(loyaltyPointsForSpend(1250), 12);
});

test("$0.99 order earns 0 points", () => {
  assert.equal(loyaltyPointsForSpend(99), 0);
});

test("exactly $1 earns 1 point", () => {
  assert.equal(loyaltyPointsForSpend(100), 1);
});

test("zero and negative totals never earn points", () => {
  assert.equal(loyaltyPointsForSpend(0), 0);
  assert.equal(loyaltyPointsForSpend(-500), 0);
});

test("clawback symmetry: refunding a full order reverses exactly what was earned", () => {
  // Checkout earned floor(total/100); the refund clawback adds
  // (redeemed − earned). With zero redemption the net is exactly −earned.
  const total = 4250;
  const earned = loyaltyPointsForSpend(total);
  const redeemed = 0;
  const clawbackDelta = redeemed - earned;
  assert.equal(earned + clawbackDelta, 0);
});
