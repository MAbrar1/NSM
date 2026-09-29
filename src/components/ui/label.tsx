"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   LABEL
   Typography only — never a shadow or a box, never interactive.
   The neu spec (13px/600/muted, `0.01em`, red `*` marker) lives in
   the `.neu-label` recipe so the form controls share one source.
   ═══════════════════════════════════════════════════════════════ */

const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & {
    error?: boolean;
    /** Renders the spec's red `*` marker via `.neu-label[data-required]`. */
    required?: boolean;
  }
>(({ className, error, required, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    data-required={required ? "true" : undefined}
    className={cn(
      "neu-label block leading-none",
      // The error label is READ, so it takes the red INK role (5.43:1 light /
      // 5.29:1 dark). The vivid accent red is 3.16:1 — decoration only.
      error && "text-neu-ink-red",
      // A `peer-disabled:cursor-not-allowed peer-disabled:opacity-70` pair
      // used to live here and was DEAD: every Label in this app renders
      // BEFORE its control (and inside its own wrapper), so no `.peer`
      // sibling can ever precede it and the selector could never match.
      // The muted state belongs to the control itself —
      // `.neu-input:disabled` / `.neu-btn:disabled` already carry it.
      className
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
