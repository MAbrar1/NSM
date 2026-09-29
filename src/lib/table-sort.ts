/* ═══════════════════════════════════════════════════════════════
   TABLE SORT — shared param codec for server-side table sorting.

   List pages keep their sort state in a single URL-ish string
   ("createdAt.desc", "name.asc") and hand it straight to the API
   as ?sort=. The API parses it with parseSortParam, which clamps
   to an allow-list — so a hand-edited query can never reach
   Prisma's orderBy and throw on an unknown field.

   Pair with <SortableTh> (ui/sortable-th.tsx), which renders the
   clickable header and the aria-sort contract.
   ═══════════════════════════════════════════════════════════════ */

export interface SortSpec {
  field: string;
  order: "asc" | "desc";
}

/**
 * Parse a `?sort=field.asc` value against an allow-list of sortable
 * fields. Anything malformed — unknown field, bad direction, wrong
 * shape, non-string input — falls back to the given default, so the
 * route handler can pass the result straight into `orderBy`.
 */
export function parseSortParam(
  value: string | null | undefined,
  allowedFields: readonly string[],
  fallback: SortSpec
): SortSpec {
  if (!value) return fallback;
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return fallback;
  const field = value.slice(0, dot);
  const order = value.slice(dot + 1);
  if (!allowedFields.includes(field)) return fallback;
  return { field, order: order === "asc" ? "asc" : "desc" };
}

/** Encode a field + order back into the wire format (`name.asc`). */
export function encodeSortParam(field: string, order: "asc" | "desc"): string {
  return `${field}.${order}`;
}
