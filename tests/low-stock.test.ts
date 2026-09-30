/* ═══════════════════════════════════════════════════════════════
   LOW-STOCK CLASSIFICATION — unit tests
   Locks the severity/kind ladder used by the notification bell, the
   manual trigger and the scheduled notifier:
   out_of_stock → critical (≤50% of min) → below_min (≤ min) → no alert.
   The ladder stops at the product's own minimum so it matches
   stockStatus() (lib/stock-status) — the rule every screen displays.
   Run: npx tsx --test tests/low-stock.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRestockSoon, classifyStock, DEFAULT_COOLDOWN_HOURS } from "@/lib/inventory/low-stock";
import { needsRestock, stockStatus } from "@/lib/inventory/stock-status";

// Product with min = 10
const MIN = 10;

test("zero or negative stock is out_of_stock critical", () => {
  assert.deepEqual(classifyStock(0, MIN), { severity: "critical", kind: "out_of_stock" });
  assert.deepEqual(classifyStock(-2, MIN), { severity: "critical", kind: "out_of_stock" });
});

test("stock at/below 50% of min is critical", () => {
  assert.deepEqual(classifyStock(5, MIN), { severity: "critical", kind: "critical" });
  assert.deepEqual(classifyStock(1, MIN), { severity: "critical", kind: "critical" });
  // floor(10 × 0.5) = 5 inclusive
  assert.deepEqual(classifyStock(5, MIN)!.kind, "critical");
});

test("stock between 50% and min is below_min warning", () => {
  assert.deepEqual(classifyStock(10, MIN), { severity: "warning", kind: "below_min" });
  assert.deepEqual(classifyStock(6, MIN), { severity: "warning", kind: "below_min" });
});

test("stock above min never alerts (the running_low band is retired)", () => {
  // Stock that is well under max but still above the product's own minimum
  // is NOT an alert — this is what kept the dashboard's low-stock count
  // bigger than the catalog. Every screen calls these rows OK.
  assert.equal(classifyStock(11, MIN), null);
  assert.equal(classifyStock(20, 10), null);
  assert.equal(classifyStock(30, 10), null);
});

test("healthy stock above the thresholds produces no alert", () => {
  assert.equal(classifyStock(50, 10), null);
  assert.equal(classifyStock(1000, MIN), null);
});

test("cooldown default is 6 hours", () => {
  assert.equal(DEFAULT_COOLDOWN_HOURS, 6);
});

test("restock-soon band never overlaps the low-stock rule", () => {
  // The opt-in early warning must be strictly additive: it can only fire where
  // classifyStock says "no alert", otherwise turning it on would move the
  // low-stock numbers — the whole point of keeping it in its own channel.
  for (const min of [5, 10, 25]) {
    for (const max of [30, 100, 400]) {
      for (let qty = -1; qty <= max; qty += 1) {
        const lowAlert = classifyStock(qty, min) !== null;
        const soon = classifyRestockSoon(qty, min, max);
        if (soon) assert.equal(lowAlert, false, `overlap at qty=${qty} min=${min} max=${max}`);
      }
    }
  }
});

test("restock-soon band is empty for the implicit max (min × 3)", () => {
  // With no explicit maxStockLevel the band collapses below the minimum, so
  // "restock soon" only means something once a store defines what "full" is.
  const min = 10;
  const implicitMax = Math.max(min * 3, 1);
  for (let qty = -1; qty <= 60; qty += 1) {
    assert.equal(classifyRestockSoon(qty, min, implicitMax), false, `qty=${qty}`);
  }
  // With a real max it fires strictly between the minimum and 30% of max.
  assert.equal(classifyRestockSoon(20, 10, 100), true);
  assert.equal(classifyRestockSoon(30, 10, 100), true); // floor(100 × 0.3) inclusive
  assert.equal(classifyRestockSoon(31, 10, 100), false);
  assert.equal(classifyRestockSoon(10, 10, 100), false); // at the minimum → a real alert
  assert.equal(classifyRestockSoon(9, 10, 100), false); // below minimum → a real alert
});

test("rule parity after retiring the band: no quantity alerts without being low", () => {
  // Sweep the aggregate judgement used by the dashboard counter.
  for (const min of [0, 5, 10, 25]) {
    for (let qty = -1; qty <= 60; qty += 0.5) {
      assert.equal(classifyStock(qty, min) !== null, needsRestock(stockStatus(qty, min)), `qty=${qty}`);
    }
  }
});

test("degenerate thresholds behave sanely", () => {
  // min = 0 means "no minimum" → quantity 0 still flags, positive is safe
  assert.equal(classifyStock(0, 0)?.kind, "out_of_stock");
  assert.equal(classifyStock(1, 0), null);
  // Fractional stock survives the 50%-of-min band (floor(1 × 0.5) = 0,
  // so only a true zero reaches out_of_stock)
  assert.deepEqual(classifyStock(0.4, 1), { severity: "warning", kind: "below_min" });
});
