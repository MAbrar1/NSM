/* ═══════════════════════════════════════════════════════════════
   QUERY DATE PARSING (shared)
   Several list/report routes accept date filters as local
   YYYY-MM-DD days and build `new Date(`${raw}T00:00:00`)` from them
   directly. A malformed value — e.g. the literal string "null" that
   a stale drill-down link once sent as `?from=null&to=null` — parses
   to an Invalid Date, which Prisma rejects with a 500 and takes the
   whole page down (the reports/refunds GETs).

   These helpers validate the shape and the parse, and return null for
   anything that isn't a real calendar day so a bad param degrades to
   "no filter" instead of crashing the request. A strict `YYYY-MM-DD`
   check mirrors what the <input type="date"> pickers produce, and a
   round-trip comparison rejects impossible days like 2024-02-31 that
   JS would otherwise silently roll forward to Mar 2.
   ═══════════════════════════════════════════════════════════════ */

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a local `YYYY-MM-DD` day, or null when missing/invalid. */
function parseLocalDay(raw: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!raw) return null;
  const match = YMD.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-trip: JS rolls 2024-02-31 forward, so require the components
  // to survive the Date constructor unchanged.
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** Parse a local `YYYY-MM-DD` start-of-day. Returns null when missing or invalid. */
export function parseQueryDateStart(raw: string | null | undefined): Date | null {
  const day = parseLocalDay(raw);
  if (!day) return null;
  return new Date(day.y, day.m - 1, day.d, 0, 0, 0, 0);
}

/** Parse a local `YYYY-MM-DD` end-of-day (23:59:59.999). Returns null when missing or invalid. */
export function parseQueryDateEnd(raw: string | null | undefined): Date | null {
  const day = parseLocalDay(raw);
  if (!day) return null;
  return new Date(day.y, day.m - 1, day.d, 23, 59, 59, 999);
}
