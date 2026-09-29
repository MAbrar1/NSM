import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   BADGE — Electric Embossed Neumorphism
   Pills wear the SMALLER inset: a 4px inset reads muddy at pill
   scale. Every visual (24px height, 12px radius, 12px/600, the
   inset pair) comes from the `.neu-badge` recipe in globals.css.

   Variants are TEXT COLOUR ONLY, per the spec — but the colour is the
   legible --neu-ink-* token rather than the vivid accent. At 12px the
   vivid pairs measured 1.16–3.16:1 on --neu-bg; the inks clear 4.5:1
   while keeping the same hue (deep teal / forest / amber / brick), so
   the four variants stay individually distinguishable. The label text
   carries the meaning, so colour is never the only signal.

   The `solid-*` variants remain the filled alternative (accent fill +
   dark ink, 4.97–11.9:1) for anywhere the pill needs to pop.
   ═══════════════════════════════════════════════════════════════ */

const badgeVariants = cva(["neu-badge"], {
  variants: {
    variant: {
      default: "neu-badge-neutral",
      primary: "neu-badge-info",
      info: "neu-badge-info",
      success: "neu-badge-success",
      warning: "neu-badge-warning",
      danger: "neu-badge-danger",
      "solid-primary": "neu-badge-solid",
      "solid-success": "neu-badge-solid neu-badge-success",
      "solid-warning": "neu-badge-solid neu-badge-warning",
      "solid-danger": "neu-badge-solid neu-badge-danger",
    },
    size: {
      sm: "h-5 px-2 text-[10px]",
      md: "",
      lg: "h-7 px-3 text-[13px]",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "md",
  },
});

/** Dot colour per variant — legible ink, so the dot clears 3:1. */
const DOT_COLOR: Record<string, string> = {
  default: "bg-neu-muted",
  primary: "bg-neu-ink-cyan",
  info: "bg-neu-ink-cyan",
  success: "bg-neu-ink-green",
  warning: "bg-neu-ink-amber",
  danger: "bg-neu-ink-red",
  "solid-primary": "bg-neu-primary",
  "solid-success": "bg-neu-ink-green",
  "solid-warning": "bg-neu-ink-amber",
  "solid-danger": "bg-neu-ink-red",
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, size, dot, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant, size, className }))}
      {...props}
    >
      {dot && (
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            DOT_COLOR[variant ?? "default"] ?? "bg-neu-muted"
          )}
        />
      )}
      {children}
    </span>
  )
);

Badge.displayName = "Badge";

export { Badge };

export { badgeVariants };
export type BadgeVariant = "default" | "primary" | "info" | "success" | "warning" | "danger" | "solid-primary" | "solid-success" | "solid-warning" | "solid-danger";
export type BadgeSize = "sm" | "md" | "lg";

