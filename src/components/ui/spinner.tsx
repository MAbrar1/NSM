import * as React from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   SPINNER — the one busy indicator.

   Before this there were three shapes for the same idea: the Button's
   own inline SVG, a CSS border-ring in the POS search dropdown, and
   another border-ring in the image uploader. They used different
   colours and different sizes. This is the single source.

   It inherits `currentColor`, so it takes the ink of whatever it sits
   in (a Button's label colour, a muted hint, etc.) and follows the
   token ladder for free.

   Accessibility: decorative by default (`aria-hidden`). A spinner is
   almost always paired with text that already says "loading", and a
   second announcement is noise. When it is the ONLY signal, pass
   `label` so it becomes a named `role="status"`.
   ═══════════════════════════════════════════════════════════════ */

const SIZES = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
} as const;

export type SpinnerSize = keyof typeof SIZES;

interface SpinnerProps extends React.SVGProps<SVGSVGElement> {
  size?: SpinnerSize;
  /** Accessible name. Omit when adjacent text already announces loading. */
  label?: string;
}

export function Spinner({ size = "sm", label, className, ...props }: SpinnerProps) {
  return (
    <svg
      {...(label
        ? { role: "status", "aria-label": label }
        : { "aria-hidden": true })}
      className={cn("animate-spin shrink-0", SIZES[size], className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      {...props}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}
