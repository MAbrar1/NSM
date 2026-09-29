"use client";

import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   SEPARATOR
   A 1px line has no surface for a blurred shadow to read on, so the
   neu treatment is a two-line emboss (dark edge + light highlight)
   rather than `.neu-inset`. Both orientations are defined once in
   globals.css.
   ═══════════════════════════════════════════════════════════════ */

const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(
  (
    { className, orientation = "horizontal", decorative = true, ...props },
    ref
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0",
        orientation === "horizontal"
          ? "neu-separator-h w-full"
          : "neu-separator-v h-full",
        className
      )}
      {...props}
    />
  )
);
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
