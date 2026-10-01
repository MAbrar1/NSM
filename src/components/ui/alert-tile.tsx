"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  type AlertSeverity,
  type StockAlert,
  alertMessage,
  auditAlertForEntry,
} from "@/lib/notifications/alert-utils";

/* ═══════════════════════════════════════════════════════════════
   ALERT TILE — shared compact row for alert surfaces
   Used by the notification bell and the dashboard low-stock widget so
   the two surfaces can never drift about what an alert row looks like.

   Recipe (one source of truth):
   • row: flex items-start, gap-3
   • severity dot: 6px rounded-full solid fill in the semantic solid hue
   • body: min-w-0 flex-1, product name 13px/600, meta 11px mono, message
     12px muted wrapped to the tile width
   • stock chip: recessed pill, tabular-nums, 10px/600
   ═══════════════════════════════════════════════════════════════ */

const SEVERITY_DOT: Record<AlertSeverity, string> = {
  critical: "bg-neu-solid-red",
  warning: "bg-neu-solid-amber",
  info: "bg-neu-solid-cyan",
};

/** One alert row, suitable for a bell dropdown or a dashboard list. */
export function AlertTile({
  alert,
  isNew,
  onNavigate,
  t,
}: {
  alert: StockAlert;
  isNew?: boolean;
  onNavigate?: () => void;
  t: (key: string) => string;
}) {
  return (
    <Link
      role="menuitem"
      href={`/products?search=${encodeURIComponent(alert.sku)}`}
      onClick={onNavigate}
      className="neu-focus group flex items-start gap-3 border-b border-neu-hairline px-4 py-3 transition-colors last:border-b-0 hover:bg-neu-sunken"
    >
      <span
        className={cn(
          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
          SEVERITY_DOT[alert.severity]
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-neu-primary" title={`${alert.productName}`}>
            {alert.productName}
          </span>
          {isNew && (
            <span className="shrink-0 rounded-full bg-neu-accent-solid px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-neu-solid-ink">
              {t("header.new")}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-neu-faint" title={`${alertMessage(alert, t)}`}>
          {alertMessage(alert, t)}
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-neu-faint" title={`${alert.warehouseName} · ${alert.sku}`}>
          {alert.warehouseName} · <span className="font-mono">{alert.sku}</span>
        </span>
      </span>
      <span className="mt-1 shrink-0 rounded bg-neu-sunken px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-neu-muted">
        {alert.currentStock}
      </span>
    </Link>
  );
}

/** Lightweight inline version for dense dashboard lists (no link chrome). */
export function AlertTileInline({ alert, t }: { alert: StockAlert; t: (key: string) => string }) {
  const severity = alert.severity === "critical"
    ? "critical"
    : alert.severity === "warning"
      ? "warning"
      : "info";

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3 transition-colors",
        severity === "critical"
          ? "border-neu-ink-red/25 bg-neu-wash-red"
          : severity === "warning"
            ? "border-neu-ink-amber/25 bg-neu-wash-amber"
            : "border-neu-hairline bg-neu-sunken"
      )}
    >
      <span
        className={cn(
          "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
          severity === "critical"
            ? "bg-neu-solid-red"
            : severity === "warning"
              ? "bg-neu-solid-amber"
              : "bg-neu-solid-cyan"
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold text-neu-primary" title={`${alert.productName}`}>
            {alert.productName}
          </p>
          <span className="shrink-0 rounded bg-neu-bg/70 px-1.5 py-0.5 text-[10px] font-semibold text-neu-muted tabular-nums">
            {alert.currentStock}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-neu-faint font-mono">
          {alert.sku} · {alert.warehouseName}
        </p>
        <p
          className={cn(
            "mt-1 text-xs leading-relaxed",
            alert.severity === "info" ? "text-neu-faint" : "text-neu-muted"
          )}
        >
          {alertMessage(alert, t)}
        </p>
      </div>
    </div>
  );
}
