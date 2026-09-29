/* ═══════════════════════════════════════════════════════════════
   MULTI-UNIT HELPER LIBRARY
   Single source of truth for unit-aware quantities:
   - base unit of a product (pcs, kg, L…) and its common sub-units
   - sensible quantity formatting ("2.5 kg", "500 g", "3 pcs")
   - weight/volume ↔ value conversions ("Rs 50 worth of sugar at
     Rs 130/kg → ~385 g") used by the POS sell dialogs.
   ═══════════════════════════════════════════════════════════════ */

export interface UnitConversion {
  /** Sub-unit code, e.g. "g" when the base unit is "kg". */
  unit: string;
  /** How many base units equal ONE sub-unit (1 g = 0.001 kg). */
  factor: number;
}

/** Common base units sold at the register. */
export const COMMON_UNITS = ["pcs", "kg", "g", "L", "ml", "m", "dozen", "box"] as const;
export type CommonUnit = (typeof COMMON_UNITS)[number];

/** Units sold as indivisible whole items (quantity always an integer). */
export const WHOLE_UNITS = new Set(["pcs", "dozen", "box"]);

/**
 * Default sub-unit conversions for familiar loose-goods units.
 * factor = base-units per one sub-unit.
 */
const DEFAULT_CONVERSIONS: Record<string, UnitConversion[]> = {
  kg: [
    { unit: "g", factor: 0.001 },
    { unit: "kg", factor: 1 },
  ],
  g: [
    { unit: "kg", factor: 1000 },
    { unit: "g", factor: 1 },
  ],
  L: [
    { unit: "ml", factor: 0.001 },
    { unit: "L", factor: 1 },
  ],
  ml: [
    { unit: "L", factor: 1000 },
    { unit: "ml", factor: 1 },
  ],
};

/** Parse the product's stored unitConversions JSON (defensive). */
export function parseUnitConversions(raw?: string | UnitConversion[] | null): UnitConversion[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((c) => c && typeof c.unit === "string");
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? (parsed as UnitConversion[]).filter((c) => c && typeof c.unit === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * All saleable units for a product: base unit first, then its
 * conversions (de-duplicated by unit code). Falls back to defaults
 * when the product has no explicit conversions.
 */
export function getSaleUnits(
  baseUnit: string,
  rawConversions?: string | UnitConversion[] | null
): UnitConversion[] {
  const explicit = parseUnitConversions(rawConversions);
  const fallback = DEFAULT_CONVERSIONS[baseUnit] ?? [{ unit: baseUnit || "pcs", factor: 1 }];
  const list = explicit.length > 0 ? explicit : fallback;

  // Base unit always first
  const seen = new Set<string>([baseUnit]);
  const ordered: UnitConversion[] = [{ unit: baseUnit || "pcs", factor: 1 }];
  for (const c of list) {
    if (c.unit === baseUnit) continue;
    if (seen.has(c.unit)) continue;
    seen.add(c.unit);
    ordered.push(c);
  }
  return ordered;
}

/** Format a raw quantity into the product's base unit ("2.5 kg", "3 pcs"). */
export function formatBaseQty(quantity: number, unit?: string | null): string {
  return `${trimNumber(quantity)} ${unit || "pcs"}`;
}

/** Round to a tidy number of decimals (up to 4) and strip trailing zeros. */
export function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // Round to 4 decimals then stringify without scientific notation
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded);
}

/** Convert a quantity expressed in `fromUnit` into the base-unit quantity. */
export function toBaseQty(
  quantity: number,
  fromUnit: string,
  baseUnit: string,
  rawConversions?: string | UnitConversion[] | null
): number {
  if (fromUnit === baseUnit || !fromUnit) return quantity;
  const conversions = getSaleUnits(baseUnit, rawConversions);
  const conv = conversions.find((c) => c.unit === fromUnit);
  if (!conv) return quantity;
  return quantity * conv.factor;
}

/** Convert a base-unit quantity into `targetUnit` (for display). */
export function fromBaseQty(
  baseQuantity: number,
  targetUnit: string,
  baseUnit: string,
  rawConversions?: string | UnitConversion[] | null
): number {
  if (targetUnit === baseUnit || !targetUnit) return baseQuantity;
  const conversions = getSaleUnits(baseUnit, rawConversions);
  const conv = conversions.find((c) => c.unit === targetUnit);
  if (!conv || conv.factor === 0) return baseQuantity;
  return baseQuantity / conv.factor;
}

/**
 * Compute how much of a product a given purchase amount buys.
 * e.g. sell sugar @ Rs 130/kg; customer pays Rs 50 → ~0.3846 kg (385 g).
 * `unitPriceCents` is the price of ONE base unit, in cents.
 */
export function quantityForValue(
  valueCents: number,
  unitPriceCents: number
): number {
  if (unitPriceCents <= 0) return 0;
  return valueCents / unitPriceCents;
}

/**
 * The human-readable description of what a purchase amount buys.
 * e.g. amount Rs 50 @ Rs 130/kg base kg → "0.38 kg (384.6 g)".
 */
export function describeValuePurchase(
  valueCents: number,
  unitPriceCents: number,
  baseUnit: string,
  rawConversions?: string | UnitConversion[] | null
): { baseQty: number; display: string } {
  const baseQty = quantityForValue(valueCents, unitPriceCents);
  const conversions = getSaleUnits(baseUnit, rawConversions);
  const sub = conversions.find((c) => c.unit !== baseUnit && c.factor < 1);

  if (sub && baseQty > 0 && baseQty < 1) {
    const inSub = fromBaseQty(baseQty, sub.unit, baseUnit, rawConversions);
    return {
      baseQty,
      display: `${trimNumber(inSub)} ${sub.unit}`,
    };
  }
  return { baseQty, display: `${trimNumber(baseQty)} ${baseUnit}` };
}

/** Validate a fractional/weight sale doesn't exceed available stock. */
export function clampToStock(qty: number, available: number): number {
  if (available <= 0) return 0;
  return Math.min(qty, available);
}

/**
 * Compact label for a cart/receipt line: whole units keep plain numbers
 * ("2"), weight/volume units keep their unit ("0.385 kg", "500 ml").
 */
export function lineQtyLabel(quantity: number, unit?: string | null): string {
  const u = unit && unit !== "pcs" ? unit : null;
  return u ? `${trimNumber(quantity)} ${u}` : trimNumber(quantity);
}

/**
 * Splits a base-unit quantity into a primary label plus a friendlier
 * alternate unit when it reads better ("0.385 kg" → "385 g").
 */
export function smartQtyParts(
  quantity: number,
  unit?: string | null,
  rawConversions?: string | UnitConversion[] | null
): { primary: string; alt?: string } {
  const u = unit || "pcs";
  if (u === "pcs" || u === "dozen" || u === "box") {
    return { primary: trimNumber(quantity) };
  }
  const conversions = getSaleUnits(u, rawConversions);

  // Prefer a smaller sub-unit when the amount is a fraction of the base
  const small = conversions.find((c) => c.unit !== u && c.factor < 1);
  if (small && quantity > 0 && quantity < 1) {
    const inSub = quantity / small.factor;
    if (inSub >= 0.01) {
      return { primary: `${trimNumber(quantity)} ${u}`, alt: `${trimNumber(inSub)} ${small.unit}` };
    }
  }

  // Prefer a larger unit when the amount is big in a small base (1200 g → 1.2 kg)
  const large = conversions.find((c) => c.unit !== u && c.factor > 1);
  if (large && quantity >= large.factor) {
    const inLarge = quantity / large.factor;
    return { primary: `${trimNumber(quantity)} ${u}`, alt: `${trimNumber(inLarge)} ${large.unit}` };
  }

  return { primary: `${trimNumber(quantity)} ${u}` };
}
