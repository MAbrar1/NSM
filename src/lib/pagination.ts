/* ═══════════════════════════════════════════════════════════════
   PAGINATION (shared parser)
   Every list route used to inline:
     const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
   which has two defects:
   1. `parseInt("abc")` → NaN, and Math.max(1, NaN) === NaN →
      `skip: NaN` reaches Prisma and crashes the request (500).
   2. The pageSize cap was inconsistently applied — at least one route
      (inventory ?lowStock=true) lost its Math.min(100, …) cap, letting
      a single request fetch the whole table.

   parsePagination fixes both: NaN → default, always clamped.
   ═══════════════════════════════════════════════════════════════ */

export interface PaginationParams {
  page: number;
  pageSize: number;
  /** (page-1) * pageSize — for Prisma `skip`. */
  skip: number;
  /** pageSize — for Prisma `take`. */
  take: number;
}

function toInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse and clamp `page` / `pageSize` search params.
 * - page starts at 1 (0 and negatives are pulled up to 1)
 * - the size param is clamped to [1, maxPageSize]
 * - NaN / garbage values fall back to the defaults
 * - `pageSizeParam` selects the size param's name — newer routes use
 *   `limit`, older ones `pageSize` (defaults to "pageSize")
 */
export function parsePagination(
  searchParams: URLSearchParams,
  options: {
    defaultPageSize?: number;
    maxPageSize?: number;
    pageSizeParam?: string;
  } = {}
): PaginationParams {
  const defaultPageSize = options.defaultPageSize ?? 20;
  const maxPageSize = options.maxPageSize ?? 100;
  const sizeParam = options.pageSizeParam ?? "pageSize";

  const page = Math.max(1, toInt(searchParams.get("page"), 1));
  const pageSize = Math.min(
    maxPageSize,
    Math.max(1, toInt(searchParams.get(sizeParam), defaultPageSize))
  );

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
