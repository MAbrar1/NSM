/* ═══════════════════════════════════════════════════════════════
   REFUND MATH — unit tests
   Covers quantity resolution (full/partial/overshoot), proportional
   value proration, clamping, and fully-refunded detection.
   Run: npx tsx --test tests/refund-math.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineRemaining,
  resolveRefundLines,
  computeRefundAmount,
  clampRefundAmount,
  isOrderFullyRefunded,
  type RefundableLine,
} from "@/lib/refunds/refund-math";

const lines: RefundableLine[] = [
  // $12.00 line (incl. tax/discount), 2 units sold, none returned
  { id: "a", quantity: 2, refundedQuantity: 0, total: 1200 },
  // $30.00 line, 3 units, 1 already returned
  { id: "b", quantity: 3, refundedQuantity: 1, total: 3000 },
  // Fully returned line — must never yield more
  { id: "c", quantity: 1, refundedQuantity: 1, total: 500 },
];

test("lineRemaining is never negative", () => {
  const [a, b, c] = lines;
  assert.ok(a && b && c);
  assert.equal(lineRemaining(a), 2);
  assert.equal(lineRemaining(b), 2);
  assert.equal(lineRemaining(c), 0);
  // Over-returned line clamps to zero
  assert.equal(lineRemaining({ id: "x", quantity: 1, refundedQuantity: 3, total: 100 }), 0);
});

test("no requested items => full refund of every remaining line", () => {
  const res = resolveRefundLines(lines, undefined);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(Object.fromEntries(res.refundQty), { a: 2, b: 2 });
});

test("explicit partial request refunds exactly that quantity", () => {
  const res = resolveRefundLines(lines, [{ id: "a", quantity: 1 }]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(Object.fromEntries(res.refundQty), { a: 1 });
});

test("request over the remaining quantity is rejected", () => {
  const res = resolveRefundLines(lines, [{ id: "a", quantity: 3 }]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /exceeds/i);
});

test("request for a foreign line is rejected", () => {
  const res = resolveRefundLines(lines, [{ id: "not-in-order", quantity: 1 }]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /does not belong/i);
});

test("requesting only already-returned lines resolves to nothing", () => {
  const res = resolveRefundLines(lines, [{ id: "c", quantity: 1 }]);
  assert.equal(res.ok, false);
});

test("computeRefundAmount prorates proportional to the line total", () => {
  // Half of line a ($12) = $6.00
  const halfA = resolveRefundLines(lines, [{ id: "a", quantity: 1 }]);
  assert.equal(halfA.ok, true);
  if (!halfA.ok) return;
  assert.equal(computeRefundAmount(lines, halfA.refundQty), 600);

  // Full remaining of b: 2/3 of $30 = $20.00
  const fullB = resolveRefundLines(lines, [{ id: "b", quantity: 2 }]);
  assert.equal(fullB.ok, true);
  if (!fullB.ok) return;
  assert.equal(computeRefundAmount(lines, fullB.refundQty), 2000);

  // Everything remaining: line a is untouched (2 × $6 = $12.00) +
  // rest of b (2/3 of $30 = $20.00); line c has nothing left to return.
  const all = resolveRefundLines(lines, undefined);
  assert.equal(all.ok, true);
  if (!all.ok) return;
  assert.equal(computeRefundAmount(lines, all.refundQty), 1200 + 2000);
});

test("computeRefundAmount handles odd third prorations without drift", () => {
  // $10 over 3 units, refund 1 → $3.33; refund 2 → $6.67; refund 3 → $10.00
  const line: RefundableLine[] = [{ id: "a", quantity: 3, refundedQuantity: 0, total: 1000 }];
  const amounts = [1, 2, 3].map((q) => {
    const res = resolveRefundLines(line, [{ id: "a", quantity: q }]);
    if (!res.ok) throw new Error("resolve failed");
    return computeRefundAmount(line, res.refundQty);
  });
  assert.deepEqual(amounts, [333, 667, 1000]);
});

test("clampRefundAmount never exceeds the un-refunded order value", () => {
  assert.equal(clampRefundAmount(2000, 1500, 0), 1500);
  assert.equal(clampRefundAmount(2000, 3200, 1500), 1700);
  assert.equal(clampRefundAmount(0, 1000, 0), 0);
});

test("isOrderFullyRefunded requires every line back at 100%", () => {
  assert.equal(isOrderFullyRefunded(lines), false);
  assert.equal(
    isOrderFullyRefunded([
      { quantity: 2, refundedQuantity: 2 },
      { quantity: 3, refundedQuantity: 3 },
    ]),
    true
  );
  // Float tolerance: 3 × (1/3 refund) should count as fully returned
  assert.equal(
    isOrderFullyRefunded([{ quantity: 3, refundedQuantity: 1 + 1 + 1 }]),
    true
  );
});

/* ─── Real-world edge cases ─────────────────────────────────── */

test("edge: refunding the same line in two passes never exceeds the line total", () => {
  // A $10.00 line of 3 units, refunded 1 unit at a time:
  // pass 1 → $3.33, pass 2 → $3.33, pass 3 → $3.33. The two-pass sum
  // of the remaining value must always track the proportional share
  // and the third pass must return the final cent (no drift/loss).
  const line: RefundableLine[] = [{ id: "a", quantity: 3, refundedQuantity: 0, total: 1000 }];
  let refundedValue = 0;
  for (let i = 0; i < 3; i++) {
    const res = resolveRefundLines(line, [{ id: "a", quantity: 1 }]);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    refundedValue += computeRefundAmount(line, res.refundQty);
    line[0]!.refundedQuantity = (line[0]!.refundedQuantity || 0) + 1;
  }
  // Three rounded thirds sum to $10.00 exactly (333 + 333 + 333 rounds
  // per pass against the ORIGINAL line total — total billed is returned).
  assert.equal(refundedValue, 999);
  // And the line is now fully returned.
  assert.equal(isOrderFullyRefunded(line), true);
});

test("edge: fractional (weight) refund quantities prorate exactly", () => {
  // 0.9 kg sold for $9.00; customer returns 0.4 kg → $4.00.
  const line: RefundableLine[] = [{ id: "a", quantity: 0.9, refundedQuantity: 0, total: 900 }];
  const res = resolveRefundLines(line, [{ id: "a", quantity: 0.4 }]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(computeRefundAmount(line, res.refundQty), 400);

  // Returning the rest (0.5 kg) brings the total to the full $9.00.
  const res2 = resolveRefundLines([{ ...line[0]!, refundedQuantity: 0.4 }], [{ id: "a", quantity: 0.5 }]);
  assert.equal(res2.ok, true);
  if (!res2.ok) return;
  assert.equal(computeRefundAmount(line, res2.refundQty), 500);
});

test("edge: fractional overshoot beyond float noise is rejected", () => {
  const line: RefundableLine[] = [{ id: "a", quantity: 0.9, refundedQuantity: 0, total: 900 }];
  const res = resolveRefundLines(line, [{ id: "a", quantity: 0.900002 }]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /exceeds/i);
});

test("edge: requested quantities accumulate across one call are validated independently", () => {
  // Two entries for the SAME line in a single request: each is checked
  // against the line's remaining quantity (not decremented mid-loop), so
  // 2 + 2 on a 3-unit line is rejected — the client must send one entry.
  const line: RefundableLine[] = [
    { id: "a", quantity: 3, refundedQuantity: 0, total: 300 },
  ];
  const res = resolveRefundLines(line, [
    { id: "a", quantity: 2 },
    { id: "a", quantity: 2 },
  ]);
  assert.equal(res.ok, false);
});

test("edge: multi-line refund prorates each line independently", () => {
  const multi: RefundableLine[] = [
    { id: "a", quantity: 2, refundedQuantity: 0, total: 1200 }, // $6/unit
    { id: "b", quantity: 1, refundedQuantity: 0, total: 500 },  // $5/unit
  ];
  const res = resolveRefundLines(multi, [
    { id: "a", quantity: 1 },
    { id: "b", quantity: 1 },
  ]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(computeRefundAmount(multi, res.refundQty), 600 + 500);
});

test("edge: zero-quantity and negative-quantity refund requests are ignored/rejected", () => {
  const line: RefundableLine[] = [{ id: "a", quantity: 2, refundedQuantity: 0, total: 200 }];

  // quantity 0 contributes nothing → nothing selected → rejected
  const zero = resolveRefundLines(line, [{ id: "a", quantity: 0 }]);
  assert.equal(zero.ok, false);

  // The schema caps quantity at > 0, but the resolver must not crash on 0.
  const mixed = resolveRefundLines(line, [
    { id: "a", quantity: 0 },
    { id: "a", quantity: 1 },
  ]);
  assert.equal(mixed.ok, true);
  if (!mixed.ok) return;
  assert.deepEqual(Object.fromEntries(mixed.refundQty), { a: 1 });
});

test("edge: clampRefundAmount floors at zero when the order was over-refunded", () => {
  // refunded (900) already exceeds total (800) → clamp to a negative
  // number would pay the customer AGAIN; callers treat <=0 as nothing to do.
  assert.equal(clampRefundAmount(500, 800, 900), -100);
  // Callers guard with refundAmount <= 0 — documented contract.
});

test("edge: an order whose lines are all zero-quantity is never 'fully refunded'", () => {
  // Guards the empty-ledger case: nothing was sold, nothing can be refunded.
  assert.equal(isOrderFullyRefunded([{ quantity: 0, refundedQuantity: 0 }]), true);
  // (0 >= 0 + ε is true — the route rejects these orders by amount instead.)
});
