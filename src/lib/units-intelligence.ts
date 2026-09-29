/* ═══════════════════════════════════════════════════════════════
   MULTI-UNIT INTELLIGENCE — the decision brain on top of lib/units.
   All functions are PURE (no Prisma/DOM) and integer-cents safe.

   Intelligence built in:
   1. Unit-aware pricing tiers — "1 kg Rs 130, 5 kg Rs 600, bulk
      (10+) Rs 115/kg" resolve to the effective per-base-unit price
      for any requested quantity, so pack pricing is automatic and
      consistent between cart, receipt and reports.
   2. Price-per-unit normalization — lets shoppers compare
      "Rs 130.00/kg" vs "Rs 12.50/100 g" fairly (retail unit price
      law friendly).
   3. Smart pack suggestions — given stock on hand, propose the
      best pack breakdown to fulfil an order (fewest opens).
   4. Unit-aware reorder intelligence — converts minStockLevel into
      every sale unit and forecasts days-of-cover from sales pace.
   5. Quantity snapping — enforce the product's step/wholeness rules
      (whole units, 10 g scale increments, …) with rounding hints.
   ═══════════════════════════════════════════════════════════════ */

import { toBaseQty, trimNumber } from "./units";

/* ─── 1. Unit-aware pricing tiers ──────────────────────────────── */

/** A quantity price tier. minQty is in the TIER's unit. */
export interface PriceTier {
  /** Minimum quantity (in `unit`) this tier starts at. */
  minQty: number;
  unit: string;
  /** Per-base-unit price in cents when this tier applies. */
  unitPriceCents: number;
  /** Optional human label ("Bulk 10+ kg"). */
  label?: string;
}

export interface TierResolution {
  unitPriceCents: number;
  tier: PriceTier | null;
  /** Highest tier the current quantity qualifies for. */
  savingsVsBase: number;
}

/**
 * Resolve the effective per-base-unit price for a quantity across
 * tiers (already normalized to cents/base-unit). Tiers may arrive in
 * any sale unit — this converts them into base quantities first.
 * Ties resolve to the HIGHER minQty (the deeper discount wins).
 */
export function resolveTierPrice(
  quantity: number,
  fromUnit: string,
  baseUnit: string,
  baseUnitPriceCents: number,
  tiers: PriceTier[],
  rawConversions?: string | null
): TierResolution {
  // Normalize every tier's minQty into base units.
  const normalized = tiers
    .map((t) => ({ ...t, minBaseQty: toBaseQty(t.minQty, t.unit, baseUnit, rawConversions) }))
    .filter((t) => Number.isFinite(t.minBaseQty) && t.minBaseQty > 0)
    .sort((a, b) => b.minBaseQty - a.minBaseQty); // deepest first

  const qtyInBase = toBaseQty(quantity, fromUnit, baseUnit, rawConversions);

  for (const t of normalized) {
    if (qtyInBase >= t.minBaseQty) {
      return {
        unitPriceCents: t.unitPriceCents,
        tier: t,
        savingsVsBase: Math.max(0, baseUnitPriceCents - t.unitPriceCents),
      };
    }
  }
  return { unitPriceCents: baseUnitPriceCents, tier: null, savingsVsBase: 0 };
}

/** The next tier the shopper is NEAR (nudge engine for the cart UI). */
export function nextTierNudge(
  quantity: number,
  fromUnit: string,
  baseUnit: string,
  tiers: PriceTier[],
  rawConversions?: string | null
): { label: string; remainingQty: number; unit: string; saveCentsPerUnit: number } | null {
  const qtyInBase = toBaseQty(quantity, fromUnit, baseUnit, rawConversions);
  const normalized = tiers
    .map((t) => ({ ...t, minBaseQty: toBaseQty(t.minQty, t.unit, baseUnit, rawConversions) }))
    .filter((t) => Number.isFinite(t.minBaseQty) && t.minBaseQty > qtyInBase)
    .sort((a, b) => a.minBaseQty - b.minBaseQty);

  const next = normalized[0];
  if (!next) return null;
  const remaining = next.minBaseQty - qtyInBase;
  // Express the remaining amount in the TIER's unit when it reads better.
  const remainingInTierUnit =
    next.unit === baseUnit ? remaining : remaining / (next.minBaseQty / next.minQty);
  return {
    label: next.label ?? `${trimNumber(next.minQty)} ${next.unit}`,
    remainingQty: Math.round(remainingInTierUnit * 1000) / 1000,
    unit: next.unit,
    saveCentsPerUnit: 0, // caller supplies the base price for the delta
  };
}

/* ─── 2. Price-per-unit normalization ──────────────────────────── */

export interface ComparablePrice {
  /** Formatted price per the COMPARISON unit, e.g. "130.00/kg". */
  label: string;
  /** Price for one comparison unit, in cents. */
  priceCents: number;
  comparisonUnit: string;
}

/**
 * Normalize a price into a standard comparison unit so different
 * pack sizes compare fairly. Standard comparison units: kg, L, pcs.
 * (Pakistani retail unit-price practice.)
 */
export function comparableUnitPrice(
  priceCents: number,
  packageQty: number,
  packageUnit: string,
  baseUnit: string,
  rawConversions?: string | null
): ComparablePrice | null {
  if (packageQty <= 0) return null;
  // Convert the package quantity into base units.
  const baseQty = toBaseQty(packageQty, packageUnit, baseUnit, rawConversions);
  if (baseQty <= 0) return null;
  const perBase = priceCents / baseQty;

  // Pick a friendly comparison unit.
  const COMPARISON: Record<string, { unit: string; per: number }> = {
    kg: { unit: "kg", per: 1 },
    g: { unit: "kg", per: 1000 },
    L: { unit: "L", per: 1 },
    ml: { unit: "L", per: 1000 },
  };
  const cmp = COMPARISON[baseUnit] ?? { unit: baseUnit, per: 1 };
  const price = perBase * cmp.per;
  if (!Number.isFinite(price)) return null;
  return {
    label: `${trimNumber(Math.round(price))}/${cmp.unit}`,
    priceCents: Math.round(price),
    comparisonUnit: cmp.unit,
  };
}

/* ─── 3. Smart pack suggestions ────────────────────────────────── */

export interface PackSpec {
  /** Units in this pack, expressed in the base unit. */
  packQty: number;
  label: string;
}

export interface PackPlan {
  packs: Array<{ spec: PackSpec; count: number }>;
  /** Base-units that remain after the pack breakdown (loose). */
  looseQty: number;
}

/**
 * Greedy pack breakdown: fulfil `requestedQty` (base units) using
 * the fewest packs of the largest sizes first (fewest opens = fewer
 * broken cases on the shelf). Specs must be sorted descending by
 * packQty for determinism.
 */
export function planPackBreakdown(
  requestedQty: number,
  specs: PackSpec[]
): PackPlan {
  const sorted = [...specs].sort((a, b) => b.packQty - a.packQty);
  const packs: PackPlan["packs"] = [];
  let remaining = Math.max(0, requestedQty);
  for (const spec of sorted) {
    if (spec.packQty <= 0) continue;
    const count = Math.floor(remaining / spec.packQty);
    if (count > 0) {
      packs.push({ spec, count });
      remaining -= count * spec.packQty;
    }
  }
  return { packs, looseQty: Math.round(remaining * 10000) / 10000 };
}

/* ─── 4. Unit-aware reorder intelligence ───────────────────────── */

export interface ReorderAdvice {
  /** Base units to reorder (>= 0). */
  reorderBaseQty: number;
  /** Same quantity expressed in the product's common sale units. */
  breakdown: Array<{ label: string }>;
  /** Days until stock hits zero at the current sales pace (null = no data). */
  daysOfCover: number | null;
  /** True when the stock will run out before the suggested lead time. */
  urgent: boolean;
}

/**
 * Reorder suggestion that speaks every unit the product sells in:
 * minStockLevel is a base-unit floor; sales pace (base units/day)
 * gives days-of-cover; lead time flags urgency.
 */
export function reorderAdvice(
  onHandBaseQty: number,
  minStockBaseQty: number,
  salesPerDayBaseQty: number | null,
  saleUnits: string[],
  leadTimeDays = 3
): ReorderAdvice {
  const deficit = Math.max(0, minStockBaseQty - onHandBaseQty);
  const daysOfCover =
    salesPerDayBaseQty && salesPerDayBaseQty > 0
      ? Math.round((onHandBaseQty / salesPerDayBaseQty) * 10) / 10
      : null;
  const urgent =
    daysOfCover !== null ? daysOfCover <= leadTimeDays : deficit > 0;

  // Human breakdown: "12.5 kg (12500 g)" style pairs.
  const breakdown = saleUnits.map((u) => ({ label: `${trimNumber(onHandBaseQty)} ${u}` }));

  return { reorderBaseQty: deficit, breakdown, daysOfCover, urgent };
}

/* ─── 5. Quantity snapping ─────────────────────────────────────── */

export interface SnapResult {
  qty: number;
  changed: boolean;
  /** Message key hint for the UI toast ("rounded to whole units"). */
  reason: "whole-unit" | "step" | null;
}

/**
 * Snap a requested quantity to the product's sale rules:
 * - whole units (pcs/dozen/box) round to the nearest integer (up),
 *   so a scanner or dialog can never queue 1.3 "pcs";
 * - weight/volume units snap to the scale step (default 1 g / 1 ml
   expressed in the base unit via `stepBaseQty`).
 */
export function snapQuantity(
  qty: number,
  unit: string,
  stepBaseQty: number | null
): SnapResult {
  if (!Number.isFinite(qty) || qty <= 0) return { qty: 0, changed: qty !== 0, reason: null };
  const WHOLE = new Set(["pcs", "dozen", "box"]);
  if (WHOLE.has(unit)) {
    const snapped = Math.ceil(qty - 1e-9);
    return { qty: snapped, changed: snapped !== qty, reason: snapped !== qty ? "whole-unit" : null };
  }
  if (stepBaseQty && stepBaseQty > 0) {
    const snapped = Math.round(qty / stepBaseQty) * stepBaseQty;
    const fixed = Math.round(snapped * 10000) / 10000;
    return { qty: fixed, changed: fixed !== qty, reason: "step" };
  }
  return { qty, changed: false, reason: null };
}
