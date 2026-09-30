"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatCurrency, formatPercent } from "@/lib/utils";
import { useAnimatedNumber } from "@/hooks/use-animated-number";

/** Default tween renderer: base cents → display currency string. */
function formatCurrencyValue(cents: number): string {
  return formatCurrency(cents);
}

/* ═══════════════════════════════════════════════════════════════
   STAT CARD — shared metric card
   Consistent icon chip, accent line, tabular figures, optional
   period-over-period delta chip. Used by the dashboard and the
   report pages so every KPI looks and behaves the same.
   ═══════════════════════════════════════════════════════════════ */

export type StatIconName = "cash" | "trend" | "box" | "alert" | "bag" | "chart" | "clock" | "wallet" | "xcircle" | "users" | "star";
export type StatTone = "brand" | "success" | "info" | "warning" | "danger";

const ICON_PATHS: Record<StatIconName, string> = {
  wallet: "M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3",
  cash: "M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z",
  trend: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  box: "M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9",
  alert: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  xcircle: "M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  bag: "M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007zM8.625 10.5a.375.375 0 11-.75 0 .375.375 0 01.75 0zm7.5 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z",
  chart: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  clock: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
  users: "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z",
  star: "M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z",
};

/* Tone colours come from the semantic neu accents, so the KPI grid and
   the badges/toasts speak one language. The accent LINE and the WASH are
   decoration, so they use the vivid accents. Anything legible on the
   surface (the icon) uses the matching ink instead. */
const TONE_ACCENT: Record<StatTone, string> = {
  brand: "bg-neu-cyan",
  success: "bg-neu-green",
  info: "bg-neu-cyan",
  warning: "bg-neu-amber",
  danger: "bg-neu-red",
};

/** Soft top-right color wash behind the icon chip. */
const TONE_WASH: Record<StatTone, string> = {
  brand: "from-neu-cyan/10 via-transparent",
  success: "from-neu-green/10 via-transparent",
  info: "from-neu-cyan/10 via-transparent",
  warning: "from-neu-amber/10 via-transparent",
  danger: "from-neu-red/10 via-transparent",
};

/* The chip is a recessed neu surface and its ink carries the tone. These
   are the legible ink tokens, not the vivid accents: a meaningful icon
   needs 3:1, and the vivid accents measure 1.2–3.2:1 on --neu-bg. */
const TONE_ICON: Record<StatTone, string> = {
  brand: "text-neu-ink-cyan",
  success: "text-neu-ink-green",
  info: "text-neu-ink-cyan",
  warning: "text-neu-ink-amber",
  danger: "text-neu-ink-red",
};

export function StatIcon({ name, className }: { name: StatIconName; className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d={ICON_PATHS[name]} />
    </svg>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  icon: StatIconName;
  tone: StatTone;
  /** Signed percentage vs. a previous period; `null` hides the chip. */
  delta?: number | null;
  /** Short hint for the delta chip (e.g. "vs yesterday"). */
  deltaLabel?: string;
  sub?: string;
  /** Stacked proportion bar (segments sum ≤ 100%). */
  bar?: StatBarSegment[];
  /** Accessible description of what the bar shows. */
  barLabel?: string;
  className?: string;
  /**
   * RAW numeric value behind `value` (base cents for money, a count for
   * tallies). When provided, the card ticks between refreshes: the
   * displayed figure eases toward the new number (600ms, ease-out) and
   * the FORMATTED string re-derives from the tweened value via
   * `formatValue`, so a 60s KPI refresh reads as movement instead of
   * a snap. Reduced-motion users skip straight to the target. The
   * initial render shows the target as-is — the ticker exists for
   * CHANGES, not for page-load theatrics.
   */
  numericValue?: number;
  /** Render the (possibly mid-tween) numeric value; defaults to currency. */
  formatValue?: (v: number) => string;
}

/** One stacked segment of the optional proportion bar. */
export interface StatBarSegment {
  /** Width of the segment in percent (0–100). */
  pct: number;
  /** Tailwind background utility, e.g. "bg-neu-ink-green". */
  className: string;
  /** Visible tooltip / accessible name. */
  label: string;
}

export function StatCard({
  label,
  value,
  icon,
  tone,
  delta,
  deltaLabel,
  sub,
  bar,
  barLabel,
  className,
  numericValue,
  formatValue = formatCurrencyValue,
}: StatCardProps) {
  const showDelta = delta !== undefined && delta !== null;
  const ticking = numericValue !== undefined && Number.isFinite(numericValue);
  const tweened = useAnimatedNumber(numericValue ?? 0, ticking);

  return (
    <Card className={cn("group relative overflow-hidden", className)}>
      {/* Accent line (clipped by overflow-hidden so it never crosses
          the 28px card radius). */}
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-0.5", TONE_ACCENT[tone])} />
      {/* Color wash (trailing corner, behind the icon). The offset is logical
          (a corner belongs to the card, which mirrors); the gradient inside the
          circle is not — a gradient has no logical form, and it fades across the
          circle itself, so mirroring the circle does not move the fade. */}
      <span
        aria-hidden
        className={cn("pointer-events-none absolute -end-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br to-transparent", TONE_WASH[tone])}
      />
      <CardContent className="relative p-6">
        <div className="flex items-start justify-between gap-3">
          <div className={cn("neu-inset flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", TONE_ICON[tone])}>
            <StatIcon name={icon} className="h-5 w-5" />
          </div>
          {showDelta && (
            <span
              title={deltaLabel}
              className={cn(
                "neu-badge tabular-nums",
                (delta ?? 0) > 0
                  ? "neu-badge-success"
                  : (delta ?? 0) < 0
                    ? "neu-badge-danger"
                    : "neu-badge-neutral"
              )}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={(delta ?? 0) >= 0 ? "M4.5 15.75l7.5-7.5 7.5 7.5" : "M19.5 8.25l-7.5 7.5-7.5-7.5"}
                />
              </svg>
              {formatPercent(delta ?? 0)}
            </span>
          )}
        </div>
        <p className="mt-4 neu-stat-label font-semibold">{label}</p>
        {/* NEVER truncate a money value: "…Rs 1,2" hides the number the card
           exists to show. The wrapping is word-safe, and tabular figures keep
           the digits readable — a stat value may grow the card, not shrink
           the truth. With a numericValue the card ticks between refreshes;
           mid-tween it renders the interpolated figure in the same format. */}
        <p className="mt-1 break-words neu-stat-value tracking-tight">
          {ticking ? formatValue(tweened) : value}
        </p>
        {sub && <p className="mt-1 text-xs text-neu-muted">{sub}</p>}
        {bar && bar.length > 0 && (
          <div
            role="img"
            aria-label={barLabel ?? label}
            title={barLabel ?? label}
            className="neu-inset-sm mt-2 flex h-1.5 w-full overflow-hidden rounded-full"
          >
            {bar.map((seg, i) => (
              <span
                key={i}
                className={seg.className}
                style={{ width: `${Math.min(100, Math.max(0, seg.pct))}%` }}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}