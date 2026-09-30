/* ═══════════════════════════════════════════════════════════════
   STOCK STATUS — unit tests
   Locks the ONE low-stock classification shared by Products, POS,
   Inventory, Dashboard and the APIs: available vs the product's own
   minimum, with the whole-unit floor for non-fractional products and
   variant rows excluded from base totals.
   Run: npx tsx --test tests/stock-status.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStock } from "@/lib/inventory/low-stock";
import {
  stockStatus,
  sellableUnits,
  sumBaseStock,
  classifyProductStock,
  isBaseStockRow,
  needsRestock,
  summarizeLowStock,
  stockStatusForRow,
} from "@/lib/inventory/stock-status";

test("stockStatus: zero or negative is out", () => {
  assert.equal(stockStatus(0, 5), "out");
  assert.equal(stockStatus(-2, 5), "out");
});

test("stockStatus: at or below min (but positive) is low", () => {
  assert.equal(stockStatus(5, 5), "low");
  assert.equal(stockStatus(1, 5), "low");
  assert.equal(stockStatus(0.5, 5), "low");
});

test("stockStatus: above min is ok", () => {
  assert.equal(stockStatus(6, 5), "ok");
  assert.equal(stockStatus(100, 5), "ok");
});

test("stockStatus: zero min never flags low", () => {
  assert.equal(stockStatus(0, 0), "out");
  assert.equal(stockStatus(1, 0), "ok");
  assert.equal(stockStatus(0.5, 0), "ok");
});

test("sellableUnits: floors whole-unit products, keeps fractional", () => {
  assert.equal(sellableUnits(10.9, false), 10);
  assert.equal(sellableUnits(10.9, true), 10.9);
  assert.equal(sellableUnits(7, false), 7);
  // Negative on-hand is broken data, never a sellable debt
  assert.equal(sellableUnits(-0.2, false), 0);
  assert.equal(sellableUnits(-0.2, true), 0);
});

test("sumBaseStock: excludes variant rows from all totals", () => {
  const rows = [
    { quantity: 10, reservedQuantity: 2, variantId: null },
    { quantity: 5, reservedQuantity: 0, variantId: null },
    { quantity: 50, reservedQuantity: 0, variantId: "v1" }, // variant — excluded
  ];
  const s = sumBaseStock(rows);
  assert.equal(s.totalStock, 15);
  assert.equal(s.totalReserved, 2);
  assert.equal(s.totalAvailable, 13);
});

test("sumBaseStock: whole-unit floor applies to sellable", () => {
  const s = sumBaseStock([{ quantity: 10, reservedQuantity: 0.4, variantId: null }], false);
  assert.equal(s.totalAvailable, 9.6);
  assert.equal(s.sellableAvailable, 9);
  const frac = sumBaseStock([{ quantity: 10, reservedQuantity: 0.4, variantId: null }], true);
  assert.equal(frac.sellableAvailable, 9.6);
});

test("sumBaseStock: empty rows are all zero", () => {
  assert.deepEqual(sumBaseStock([]), {
    totalStock: 0,
    totalReserved: 0,
    totalAvailable: 0,
    sellableAvailable: 0,
  });
});

test("isBaseStockRow: null/undefined variant counts as base", () => {
  assert.equal(isBaseStockRow({ quantity: 1, reservedQuantity: 0, variantId: null }), true);
  assert.equal(isBaseStockRow({ quantity: 1, reservedQuantity: 0 }), true);
  assert.equal(isBaseStockRow({ quantity: 1, reservedQuantity: 0, variantId: "v" }), false);
});

test("summarizeLowStock: counts DISTINCT products, never rows", () => {
  // 3 products over 3 warehouses: 1 out everywhere, 1 low everywhere, 1 fine.
  const rows: Array<{
    productId: string;
    quantity: number;
    reservedQuantity: number;
    minStockLevel: number;
  }> = [];
  for (const _wh of ["a", "b", "c"]) {
    rows.push({ productId: "p1", quantity: 0, reservedQuantity: 0, minStockLevel: 5 });
    rows.push({ productId: "p2", quantity: 4, reservedQuantity: 0, minStockLevel: 5 });
    rows.push({ productId: "p3", quantity: 50, reservedQuantity: 0, minStockLevel: 5 });
  }
  const s = summarizeLowStock(rows);
  assert.equal(s.total, 2, "9 rows collapse to 2 distinct products");
  assert.equal(s.out, 1);
  assert.equal(s.low, 1);
  assert.deepEqual(s.productIds, ["p1", "p2"]);

  // THE invariant the dashboard's Products vs Needs Restock cards rely on:
  // the distinct low-stock count can never exceed the catalog size, no matter
  // how many warehouses exist or how many rows a product contributes.
  assert.ok(s.total <= new Set(rows.map((r) => r.productId)).size);
});

test("summarizeLowStock: out wins over low for the same product", () => {
  // p1 is out in one warehouse and low in another — it must count ONCE, as out.
  const s = summarizeLowStock([
    { productId: "p1", quantity: 0, reservedQuantity: 0, minStockLevel: 5 },
    { productId: "p1", quantity: 3, reservedQuantity: 0, minStockLevel: 5 },
  ]);
  assert.equal(s.total, 1);
  assert.equal(s.out, 1);
  assert.equal(s.low, 0);
  assert.equal(s.out + s.low, s.total, "out + low must equal total");
});

test("summarizeLowStock: reserved stock is not sellable stock", () => {
  // 5 on hand, all reserved → nothing sellable → out, not low.
  const s = summarizeLowStock([
    { productId: "p1", quantity: 5, reservedQuantity: 5, minStockLevel: 3 },
  ]);
  assert.equal(s.total, 1);
  assert.equal(s.out, 1);
});

test("summarizeLowStock: empty catalog is all zeros", () => {
  assert.deepEqual(summarizeLowStock([]), { total: 0, out: 0, low: 0, productIds: [] });
});

test("needsRestock: the worklist grouping (low + out, never ok)", () => {
  assert.equal(needsRestock("low"), true);
  assert.equal(needsRestock("out"), true);
  assert.equal(needsRestock("ok"), false);
});

test("stockStatusForRow: floors to sellable units like every other surface", () => {
  // Whole-unit product with a fractional reservation: 5 − 0.5 = 4.5 → floors
  // to 4, so it is low at min 5. Subtracting inline (5 − 0.5 = 4.5 > 4) would
  // have read "ok" at min 4 — the drift this helper exists to prevent.
  assert.equal(stockStatusForRow({ quantity: 5, reservedQuantity: 0.5 }, 5), "low");
  // 5 − 0.5 = 4.5 floors to 4 → ≤ min 4 → low. A route subtracting inline
  // would have compared 4.5 > 4 and reported "ok": this pair is the drift.
  assert.equal(stockStatusForRow({ quantity: 5, reservedQuantity: 0.5 }, 4), "low");
  // Fractional (weighed) products keep their decimals: 4.5 > 4 is ok.
  assert.equal(stockStatusForRow({ quantity: 5, reservedQuantity: 0.5, allowFractional: true }, 4), "ok");
  assert.equal(stockStatusForRow({ quantity: 5, reservedQuantity: 0.5, allowFractional: true }, 5), "low");
  assert.equal(stockStatusForRow({ quantity: 0, reservedQuantity: 0 }, 5), "out");
  // Reserved units are promised elsewhere: 5 on hand, all reserved → out.
  assert.equal(stockStatusForRow({ quantity: 5, reservedQuantity: 5 }, 3), "out");
});

test("rule parity: the alert ladder agrees with stockStatus for every input", () => {
  // The bug this suite exists to prevent: the alert engine and the UI
  // classification disagreed about the same numbers. Sweep sellable quantity ×
  // minimum and assert both engines make the SAME low/not-low decision —
  // "no alert" if and only if "ok".
  for (const min of [0, 1, 5, 10, 25]) {
    for (let sellable = -1; sellable <= 60; sellable += 0.5) {
      const alerted = classifyStock(sellable, min) !== null;
      const uiSaysRestock = needsRestock(stockStatus(sellable, min));
      assert.equal(alerted, uiSaysRestock, `sellable=${sellable} min=${min}`);
    }
  }
});

test("classifyProductStock: end-to-end POS vs Products parity", () => {
  // 4 warehouses; one holds a variant row that must not count.
  const rows = [
    { quantity: 20, reservedQuantity: 5, variantId: null },
    { quantity: 3, reservedQuantity: 0, variantId: null },
    { quantity: 0, reservedQuantity: 0, variantId: null },
    { quantity: 99, reservedQuantity: 0, variantId: "v1" },
  ];
  // available = (20-5) + 3 + 0 = 18 → min 10 → ok
  assert.equal(classifyProductStock(rows, 10), "ok");
  // min 20 → low
  assert.equal(classifyProductStock(rows, 20), "low");
  // reserved eats everything → out
  const drained = [{ quantity: 5, reservedQuantity: 5, variantId: null }];
  assert.equal(classifyProductStock(drained, 3), "out");
});
