/* ═══════════════════════════════════════════════════════════════
   MONEY (pure helpers — the one major-unit → cents conversion)

   Money is stored as INTEGER CENTS of the store's base currency
   everywhere (see lib/currency-core). Anything that crosses the
   boundary between "a price the user typed / a CSV cell" and "a
   column in the database" must round the same way, or the same
   input produces different stored cents depending on which route
   handled it.

   That rule used to be re-typed as a bare `Math.round(x * 100)` in
   seven places — the products create/update routes, the variant
   create/update routes, both CSV importers and the bulk price
   adjuster — plus a copy-pasted `parseMoneyToCents` string parser
   in two importers. ONE function now owns the arithmetic; the
   string parsers only clean and validate, then call it.

   Non-finite input resolves to 0 rather than NaN so a bad CSV cell
   can never write NaN into an integer cents column.

   Hardening (regression-locked in tests/money.test.ts):
     • every public entry is total — non-finite input can never
       leak NaN/±Infinity out of this module (to a JSON body, a
       Prisma Int column, or a format call);
     • results are integers: 0.1 + 0.2 style float residue can
       never reach a cents column as a fraction;
     • out-of-range conversions saturate at ±2^31 rather than
       silently wrapping the float or overflowing a Prisma Int
       column mid-write;
     • one roundHalfUp() primitive so callers that legitimately
       scale by 100 inside lib/money share the exact same rule the
       rest of the app must go through majorToCents() for.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Round half away from zero to the nearest integer (Math.round's
 * rule, made total): NaN and ±Infinity resolve to 0. The shared
 * primitive for every cents-scale arithmetic in this module.
 */
export function roundHalfUp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/**
 * Saturate an unbounded number at ±2^31 (Prisma Int's range).
 * Beyond that, a cents column write would throw or silently
 * corrupt; clamping keeps a runaway FX rate or bulk adjuster from
 * turning one bad cell into a failed transaction.
 */
export function clampToInt(value: number): number {
  const MAX_INT = 2_147_483_647;
  if (Number.isNaN(value)) return 0;
  return Math.min(MAX_INT, Math.max(-MAX_INT, Math.round(value)));
}

/** Render integer cents as a plain two-decimal major string ("12.50").
 *  For contexts that want the raw number TEXT (CSV/Excel cells, exports,
 *  copy-out values) rather than a localized currency display — the
 *  single home for the `centsToMajorString(cents)` conversion that used
 *  to be re-derived at ~70 call sites. */
export function centsToMajorString(cents: number): string {
  if (!Number.isFinite(cents)) return "0.00";
  return (cents / 100).toFixed(2);
}

/** Major units (e.g. "12.50") → integer cents (1250). */
export function majorToCents(major: number): number {
  if (!Number.isFinite(major)) return 0;
  return clampToInt(roundHalfUp(major * 100));
}

/** Integer cents → major NUMBER (1250 → 12.5) for number-typed
 *  consumers (form fields, chart scales). Text consumers must use
 *  centsToMajorString; display consumers must use formatCurrency. */
export function centsToMajor(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return cents / 100;
}

/** Percent (12.5 = "12.5%") → ratio (0.125), non-finite → 0. The
 *  one legal ÷100 outside cents scaling: `amount * percentToRatio(p)`
 *  replaces the `amount * (p / 100)` tax/discount idiom so the lint
 *  ban on raw ÷100 keeps exactly one exception path. */
export function percentToRatio(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return percent / 100;
}

/**
 * Parse a money CELL ("$1,234.50", "12,50", "7") → integer cents, or
 * null when the cell is empty/absent/unparseable/negative. Used by the
 * CSV importers and by the export toolkit (lib/csv re-exports this), so
 * an imported price and a typed price go through exactly one rule.
 */
export function parseMoneyToCents(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return majorToCents(n);
}
