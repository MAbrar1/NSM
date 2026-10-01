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
   ═══════════════════════════════════════════════════════════════ */

/** Major units (e.g. "12.50") → integer cents (1250). */
/** Render integer cents as a plain two-decimal major string ("12.50").
 *  For contexts that want the raw number TEXT (CSV/Excel cells, exports,
 *  copy-out values) rather than a localized currency display — the
 *  single home for the `centsToMajorString(cents)` conversion that used
 *  to be re-derived at ~70 call sites. */
export function centsToMajorString(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function majorToCents(major: number): number {
  if (!Number.isFinite(major)) return 0;
  return Math.round(major * 100);
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
