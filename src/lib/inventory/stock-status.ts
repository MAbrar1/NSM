/* ═══════════════════════════════════════════════════════════════
   STOCK STATUS (pure helpers — the single low-stock rule)
   Every surface used to decide "low stock" with its own rule:
   - Products page: totalStock <= minStockLevel
   - POS grid:      available <= 5 (hardcoded!)
   - Inventory:     quantity <= minStockLevel
   - Dashboard:     counted per stock ROW (variants double-counted)
   - Alerts:        classifyStock() in lib/low-stock.ts, which also
                    flagged the extra "running_low" band (info at ≤30%
                    of maxStockLevel) nothing else agreed with

   This module is THE one classification the UI shows. lib/low-stock.ts
   (severity-grade alerting) and every page/API now delegate here, so a
   product shown "Low" on the Products page is "Low" on POS, Inventory
   and the Dashboard counter too. The retired running_low band is why the
   dashboard's low-stock card could once report more items than the store
   has products — an alert now means "low or out", nothing else.

   Pure, DB-free and framework-free → safe in client components and
   unit-testable (see tests/stock-status.test.ts).
   ═══════════════════════════════════════════════════════════════ */

/** UI stock tone shared by Products, POS, Inventory and Dashboard. */
export type StockStatus = "out" | "low" | "ok";

/**
 * Classify a sellable quantity against the product's own minimum.
 * `available` must be the quantity the UI displays (sellable units —
 * see sellableUnits) so the label always matches the number next to it.
 */
export function stockStatus(available: number, minStockLevel: number): StockStatus {
  const qty = Number.isFinite(available) ? available : 0;
  const min = Number.isFinite(minStockLevel) && minStockLevel > 0 ? minStockLevel : 0;
  if (qty <= 0) return "out";
  if (qty <= min) return "low";
  return "ok";
}

/**
 * Everything at or below its minimum — the restock worklist.
 *
 * VOCABULARY: "low" (status === "low") deliberately excludes zero stock,
 * because screens that show low and out together (Inventory KPIs, warehouse
 * summary, the inventory report) list them as two separate numbers. A screen
 * that shows ONE number — the dashboard card, the alert bell — is showing the
 * restock worklist, so it must count "low + out". Use this helper there so
 * the grouping is explicit instead of accidental.
 */
export function needsRestock(status: StockStatus): boolean {
  return status !== "ok";
}

/**
 * Sellable units for display/selling: whole-unit products floor
 * fractional remainders (0.9 of a non-fractional product can't be
 * sold), fractional (weighed) products keep their decimals. Never
 * negative — a negative on-hand is broken data, not a sellable debt.
 * The POS cart and checkout enforce the same floor — one rule.
 */
export function sellableUnits(quantity: number, allowFractional: boolean): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, allowFractional ? quantity : Math.floor(quantity));
}

/** Minimal shape of a StockLevel row these helpers accept. */
export interface StockRowLike {
  quantity: number;
  reservedQuantity: number;
  variantId?: string | null;
}

/** Base-stock rows only — variant rows are tracked/sold separately. */
export function isBaseStockRow(row: StockRowLike): boolean {
  return row.variantId == null;
}

export interface SummedStock {
  totalStock: number;
  totalReserved: number;
  totalAvailable: number;
  /** Sellable available after the whole-unit floor (non-fractional). */
  sellableAvailable: number;
}

/** Totals over a set of stock rows, before any variant filtering. */
export interface SummedRawStock {
  totalStock: number;
  totalReserved: number;
  totalAvailable: number;
}

/**
 * Minimal shape sumStockRows accepts. `reservedQuantity` is optional
 * because some callers select only `quantity` — an unselected
 * reservation counts as none, which is exactly what those callers
 * reported before.
 */
export interface StockRowQuantityLike {
  quantity: number;
  reservedQuantity?: number;
}

/**
 * Sum ANY stock rows exactly as given — base rows, or the rows that
 * belong to a single variant. This is the primitive; sumBaseStock adds
 * the base-only filter and the sellable-units floor on top.
 *
 * Callers that want ONE PRODUCT's total pass its base rows, and callers
 * that want ONE VARIANT's total pass that variant's rows. Both used to
 * hand-write `.reduce((s, sl) => s + sl.quantity, 0)`, which is why a
 * variant's figures could drift from the product's.
 */
export function sumStockRows(rows: StockRowQuantityLike[]): SummedRawStock {
  let totalStock = 0;
  let totalReserved = 0;

  for (const row of rows) {
    if (Number.isFinite(row.quantity)) totalStock += row.quantity;
    const reserved = row.reservedQuantity ?? 0;
    if (Number.isFinite(reserved)) totalReserved += reserved;
  }

  return { totalStock, totalReserved, totalAvailable: totalStock - totalReserved };
}

/**
 * Sum a product's base stock rows across all warehouses — THE totals
 * formula shared by /api/products, /api/pos/search, /api/inventory and
 * the dashboard. Variant rows are excluded by the caller passing only
 * base rows (or by filtering with isBaseStockRow first).
 */
export function sumBaseStock(rows: StockRowLike[], allowFractional = false): SummedStock {
  const { totalStock, totalReserved, totalAvailable } = sumStockRows(
    rows.filter(isBaseStockRow)
  );
  return {
    totalStock,
    totalReserved,
    totalAvailable,
    sellableAvailable: sellableUnits(totalAvailable, allowFractional),
  };
}

export interface LowStockSummary {
  /** Distinct products needing restock (out-of-stock included). */
  total: number;
  /** Distinct products with zero sellable units in at least one location. */
  out: number;
  /** Distinct products restocked-needed but not out anywhere. */
  low: number;
  /** The distinct product ids needing restock, in first-seen order. */
  productIds: string[];
}

export interface LowStockRow {
  productId: string;
  quantity: number;
  reservedQuantity: number;
  minStockLevel: number;
  allowFractional?: boolean;
}

/**
 * Status for ONE stock row (a product in a warehouse).
 *
 * Every API route must classify through this rather than subtracting
 * reservations inline: the subtraction alone skips the sellable-units floor, so
 * a whole-unit product with 0.5 reserved could read "ok" in one route and
 * "low" in another. `allowFractional` decides the floor, which is why routes
 * must select it from the product.
 */
export function stockStatusForRow(
  row: { quantity: number; reservedQuantity: number; allowFractional?: boolean },
  minStockLevel: number
): StockStatus {
  const onHand = Number.isFinite(row.quantity) ? row.quantity : 0;
  const reserved = Number.isFinite(row.reservedQuantity) ? row.reservedQuantity : 0;
  return stockStatus(sellableUnits(onHand - reserved, row.allowFractional ?? false), minStockLevel);
}

/**
 * Fold per-product×warehouse stock rows into distinct-product counts.
 *
 * A product row is a LOCATION, so counting rows inflates the total — the
 * dashboard once reported more low-stock items than the store had products
 * because one product could contribute a row per warehouse. This returns
 * distinct products, and splits them so `out + low === total` always holds
 * (a product that is out in one warehouse and merely low in another counts
 * as `out` once — the more urgent state wins, and it is never double-counted).
 *
 * `total` can therefore never exceed the number of distinct products passed
 * in, which is the invariant the dashboard's "Products" and "Low Stock" cards
 * depend on to be comparable at all.
 */
export function summarizeLowStock(rows: LowStockRow[]): LowStockSummary {
  const out = new Set<string>();
  const low = new Set<string>();
  const productIds: string[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const status = stockStatusForRow(r, r.minStockLevel);
    if (!needsRestock(status)) continue;

    if (!seen.has(r.productId)) {
      seen.add(r.productId);
      productIds.push(r.productId);
    }
    if (status === "out") out.add(r.productId);
    else low.add(r.productId);
  }

  // A product counted as out is never also counted as low.
  for (const id of out) low.delete(id);
  return { total: productIds.length, out: out.size, low: low.size, productIds };
}

/**
 * One-call classification from raw stock rows (as embedded in the
 * product queries) + the product's minimum. Used by the Products page
 * and any API that wants a ready-to-render status.
 */
export function classifyProductStock(
  rows: StockRowLike[],
  minStockLevel: number,
  allowFractional = false
): StockStatus {
  const { totalAvailable } = sumBaseStock(rows, allowFractional);
  return stockStatus(totalAvailable, minStockLevel);
}
