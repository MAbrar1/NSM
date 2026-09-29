import * as React from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   SORTABLE TH — the one sortable-column header for every table.

   Replaces the per-page hand-rolled variants (customers had the
   only one; 13 other tables shipped dead headers). The whole th
   stays clickable, the arrow appears on hover, the active column
   is pinned in the accent ink, and `aria-sort` carries the state
   for screen readers. The label is passed pre-translated, so this
   component renders on the server.

   Sorting state itself lives in the page (see src/lib/table-sort.ts
   for the shared codec; customers' toggleSort semantics are the
   reference: name/label columns open A→Z, everything else
   high→low).
   ═══════════════════════════════════════════════════════════════ */

export interface SortableThProps {
  /** Pre-translated column label (i18n happens in the caller). */
  label: React.ReactNode;
  active: boolean;
  order: "asc" | "desc";
  align?: "start" | "center" | "end";
  onClick: () => void;
  className?: string;
}

export function SortableTh({
  label,
  active,
  order,
  align = "start",
  onClick,
  className,
}: SortableThProps) {
  return (
    <th
      scope="col"
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "whitespace-nowrap px-4 py-3",
        align === "end" ? "text-end" : align === "center" ? "text-center" : "text-start",
        className
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "group/sort inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider transition-colors neu-focus rounded",
          active ? "text-neu-accent-ink" : "text-neu-faint hover:text-neu-primary",
          align === "end" && "flex-row-reverse",
          align === "center" && "flex-col"
        )}
      >
        {label}
        <svg
          aria-hidden
          className={cn(
            "h-3 w-3 transition-opacity",
            active ? "opacity-100" : "opacity-0 group-hover/sort:opacity-60"
          )}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d={order === "asc" ? "M4.5 15.75l7.5-7.5 7.5 7.5" : "M19.5 8.25l-7.5 7.5-7.5-7.5"}
          />
        </svg>
      </button>
    </th>
  );
}
