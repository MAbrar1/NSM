import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   TABLE SKELETON (shared) — Electric Embossed Neumorphism
   One loading shape for every data table: Products, Inventory,
   Orders, Customers, Suppliers, POs.

   Spec: rows are 40px tall and full-width, separated by an 8px gap.
   This component renders into a real `<table><tbody>`, so the rows
   must stay `<tr>`; the 8px separation is therefore applied as 8px
   of vertical padding on the cell rather than `gap`, which only
   exists on flex/grid containers. The inner shapes are kept because
   the height is fixed at 40px either way, and they read as "table
   loading" instead of "generic bars loading".

   The emboss + sweep come from the `.neu-skeleton` recipe.
   ═══════════════════════════════════════════════════════════════ */

export function TableSkeleton({
  rows = 8,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="products-table-row" aria-hidden="true">
          {/* pb-2 = the spec's 8px row gap. */}
          <td colSpan={24} className="px-4 pb-2">
            <div className="flex h-10 items-center gap-3">
              {/* Avatar / index dot */}
              <div
                className="neu-skeleton shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  // Stagger the sweep so rows load in a wave, not a flash
                  animationDelay: `${i * 60}ms`,
                }}
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div
                  className="neu-skeleton h-3.5"
                  style={{ width: `${42 + ((i * 13) % 26)}%`, animationDelay: `${i * 60}ms` }}
                />
                <div
                  className="neu-skeleton h-3"
                  style={{ width: `${24 + ((i * 17) % 20)}%`, animationDelay: `${i * 60 + 30}ms` }}
                />
              </div>
              {/* Trailing metric columns (price/stock/status shapes) */}
              <div
                className="neu-skeleton hidden h-3.5 w-16 sm:block"
                style={{ animationDelay: `${i * 60 + 60}ms` }}
              />
              <div
                className="neu-skeleton hidden h-3.5 w-12 md:block"
                style={{ animationDelay: `${i * 60 + 90}ms` }}
              />
              <div
                className={cn("neu-skeleton h-6 w-16", className)}
                style={{ animationDelay: `${i * 60 + 120}ms` }}
              />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
