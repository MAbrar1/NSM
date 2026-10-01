import * as React from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   EMPTY STATE — the one empty-state surface for the whole app.

   Every list, table, chart and panel that can be empty renders THIS
   component, so there is a single visual language instead of the four
   that had grown up separately (the shared component, the hand-rolled
   `.empty-state` markup on orders/products/refunds, the bare-text
   table cells on suppliers/users/purchase-orders, and the compact
   `.inventory-empty` chip).

   Neu spec: a 64px inset circle holding a muted 28px icon (red in the
   error state), a 16px/700 primary title and a 14px muted body, from
   the `.neu-empty-*` recipes in globals.css.

   Two surfaces:
   - default — wraps itself in `.neu-card` for a standalone panel;
   - `bare`  — no card, so it drops straight into a table cell or a
     card that already owns the surface.

   The `[&_svg]` rule pins the icon to the spec's 28px even when a
   caller passes its own `h-*`/`w-*` utility — an override would sit in
   the same layer and win on specificity, which is exactly how the icon
   had drifted to 20/24/32px across callers.
   ═══════════════════════════════════════════════════════════════ */

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Visual height (the parent card reserves space like a chart would). */
  height?: number | string;
  /** Failure flavour — the icon circle turns to the danger accent. */
  error?: boolean;
  /** Skip the `.neu-card` surface — for use inside a table row or an
   *  existing card. */
  bare?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  height = "100%",
  error = false,
  bare = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "text-center",
        bare
          ? "flex flex-col items-center justify-center px-4 py-12"
          : "neu-card flex items-center justify-center",
        className
      )}
      style={{ minHeight: height }}
    >
      <div className="max-w-md">
        {icon && (
          <div
            className={cn(              "neu-empty-icon mx-auto [&_svg]:h-7 [&_svg]:w-7",
              error && "neu-empty-icon-error"
            )}
          >
            {icon}
          </div>
        )}
        <p className="neu-empty-title text-balance">{title}</p>
        {description && <p className="neu-empty-body mt-1 text-pretty">{description}</p>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
