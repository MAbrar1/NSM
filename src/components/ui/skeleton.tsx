import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   SKELETON
   The emboss + the loading sweep live in the `.neu-skeleton`
   recipe (globals.css), so no shadow/hex is duplicated here.
   Callers can still override the radius with a utility class —
   utilities out-rank the recipe's `@layer components` rule.
   ═══════════════════════════════════════════════════════════════ */

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("neu-skeleton", className)}
      {...props}
    />
  );
}

export { Skeleton };
