"use client";

import * as React from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/components/providers/i18n-provider";
import { useWarehouseStore } from "@/stores/warehouse-store";
import { useNotificationStore, seenSetFor } from "@/stores/notification-store";
import { useAlerts } from "@/hooks/use-alerts";
import { usePopoverMenu } from "@/hooks/use-popover-menu";
import {
  countUnseen,
  feedAlertIds,
  sortAlertsBySeverity,
  worstSeverity,
  type AlertSeverity,
  type StockAlert,
  auditAlertForEntry,
} from "@/lib/alert-utils";
import { AlertTile } from "@/components/ui/alert-tile";

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATION BELL
   The header's in-app notification surface for low-stock alerts.

   Consistent with the dashboard Restock widget by construction: both
   render the SAME /api/alerts feed through the SAME alertMessage()
   copy and the same severity vocabulary. The bell adds the things a
   global surface owes the user:

   • a true state machine — loading / ready / disabled / error — so a
     failed scan can never render as "all stocked" (the old bug);
   • the opt-in "restock soon" channel, shown in its OWN group and
     never folded into the low-stock count;
   • the selected warehouse scope, matching the rest of the shell;
   • per-user read state (see notification-store) so the badge means
     "new since you last looked", not "current total forever".
   ═══════════════════════════════════════════════════════════════ */

const LOW_STOCK_DISPLAY = 6;
const RESTOCK_DISPLAY = 4;

const SEVERITY_DOT: Record<AlertSeverity, string> = {
  critical: "bg-neu-solid-red",
  warning: "bg-neu-solid-amber",
  info: "bg-neu-solid-cyan",
};

const SEVERITY_BADGE: Record<AlertSeverity, "danger" | "warning" | "info"> = {
  critical: "danger",
  warning: "warning",
  info: "info",
};

/** Human label for how old the rendered feed is. */
function updatedLabel(at: Date | null, t: (key: string) => string): string {
  if (!at) return "";
  const secs = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
  if (secs < 60) return t("header.updatedSeconds");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("header.updatedMinutes").replace("{n}", String(mins));
  const hours = Math.floor(mins / 60);
  return t("header.updatedHours").replace("{n}", String(hours));
}

/** One alert row, shared with the dashboard widget via AlertTile. */
function AlertRow({
  alert,
  isNew,
  onNavigate,
  t,
}: {
  alert: StockAlert;
  isNew: boolean;
  onNavigate: () => void;
  t: (key: string) => string;
}) {
  return (
    <AlertTile
      alert={alert}
      isNew={isNew}
      onNavigate={onNavigate}
      t={t}
    />
  );
}

export function NotificationBell() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;

  const selectedWarehouseId = useWarehouseStore((s) => s.selectedWarehouseId);
  const warehouses = useWarehouseStore((s) => s.warehouses);
  const selectedWarehouse = warehouses.find((w) => w.id === selectedWarehouseId) ?? null;

  const { feed, status, error, refreshing, lastUpdated, refresh } = useAlerts({
    warehouseId: selectedWarehouseId,
  });

  const seenMap = useNotificationStore((s) => s.seen);
  const markSeen = useNotificationStore((s) => s.markSeen);
  const seen = React.useMemo(() => seenSetFor(seenMap, userId), [seenMap, userId]);

  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Ids that were unread when the panel opened — they keep their "new" marker
  // for this viewing even though opening marks the feed read.
  const [newAtOpen, setNewAtOpen] = React.useState<ReadonlySet<string>>(new Set());

  const lowStock = React.useMemo(() => sortAlertsBySeverity(feed?.alerts ?? []), [feed]);
  const restockSoon = React.useMemo(() => sortAlertsBySeverity(feed?.restockSoon ?? []), [feed]);

  const total = lowStock.length + restockSoon.length;
  const worst = worstSeverity(lowStock);

  // The in-app channel can be switched off in Settings (lowStockNotifyAdmins).
  // The feed still arrives — the dashboard widget needs it — but the bell is
  // the notification surface, so it goes quiet when the store says so.
  const disabled = !!feed && !feed.inAppEnabled;
  const unseen = React.useMemo(
    () => (feed && !disabled ? countUnseen(feed, seen) : 0),
    [feed, seen, disabled]
  );

  usePopoverMenu({
    open,
    triggerRef,
    panelRef,
    onClose: () => setOpen(false),
  });

  // Outside-click close. The panel is a header dropdown, so it must yield to
  // any click elsewhere in the chrome.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function openPanel() {
    if (userId && feed) {
      const ids = feedAlertIds(feed);
      setNewAtOpen(new Set(ids.filter((id) => !seen.has(id))));
      markSeen(userId, ids);
    } else {
      setNewAtOpen(new Set());
    }
    setOpen(true);
  }

  function toggle() {
    if (open) setOpen(false);
    else openPanel();
  }

  function markAllRead() {
    if (userId && feed) markSeen(userId, feedAlertIds(feed));
    setNewAtOpen(new Set());
  }

  const ariaLabel =
    !disabled && total > 0
      ? t("header.notificationsCount").replace("{count}", String(total))
      : t("header.notifications");

  const showChannels = status === "ready" && feed !== null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        onClick={toggle}
        className={cn(
          "neu-btn neu-btn-icon-sm relative neu-focus",
          open
            ? "bg-neu-sunken text-neu-primary"
            : "text-neu-muted hover:bg-neu-sunken hover:text-neu-primary"
        )}
        title={ariaLabel}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>

        {unseen > 0 ? (
          <>
            {/* Pulse only while something is genuinely new — a permanent
                animation on a bell that is merely "full" becomes noise. */}
            <span
              aria-hidden
              className={cn(
                "absolute -end-0.5 -top-0.5 h-4 w-4 animate-ping rounded-full opacity-60",
                worst === "critical"
                  ? "bg-neu-solid-red"
                  : worst === "warning"
                    ? "bg-neu-solid-amber"
                    : "bg-neu-solid-cyan"
              )}
            />
            <span
              className={cn(
                "absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-neu-solid-ink",
                worst === "critical"
                  ? "bg-neu-solid-red"
                  : worst === "warning"
                    ? "bg-neu-solid-amber"
                    : "bg-neu-solid-cyan"
              )}
            >
              {unseen > 9 ? "9+" : unseen}
            </span>
          </>
        ) : !disabled && total > 0 ? (
          // Everything acknowledged: a quiet dot, not a number.
          <span
            aria-hidden
            className="absolute -end-0.5 -top-0.5 h-2 w-2 rounded-full bg-neu-muted"
          />
        ) : null}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={t("header.notifications")}
          className="neu-elevated absolute end-0 top-full z-50 mt-2 w-96 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-neu-hairline animate-scale-in"
        >
          {/* ── Header ── */}
          <div className="flex items-center justify-between gap-2 border-b border-neu-hairline px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <p className="text-sm font-semibold text-neu-primary">{t("header.notifications")}</p>
              {total > 0 && (
                <Badge variant={worst ? SEVERITY_BADGE[worst] : "default"} size="sm">
                  {total}
                </Badge>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {unseen > 0 && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={markAllRead}
                  className="neu-focus rounded px-1.5 py-1 text-xs font-medium text-neu-faint transition-colors hover:bg-neu-sunken hover:text-neu-primary"
                >
                  {t("header.markAllRead")}
                </button>
              )}
              <button
                role="menuitem"
                type="button"
                onClick={() => void refresh()}
                aria-label={t("dashboard.refresh")}
                title={t("dashboard.refresh")}
                className="neu-focus rounded p-1 text-neu-faint transition-colors hover:bg-neu-sunken hover:text-neu-primary"
              >
                {refreshing ? (
                  <Spinner size="sm" className="h-4 w-4" />
                ) : (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* ── Scope + channel summary ── */}
          {showChannels && (
            <div className="flex items-center justify-between gap-2 border-b border-neu-hairline bg-neu-sunken px-4 py-2">
              <span className="truncate text-[11px] text-neu-faint">
                {selectedWarehouse
                  ? t("header.scopedTo").replace("{name}", selectedWarehouse.name)
                  : t("dashboard.allWarehouses")}
              </span>
              {!disabled && total > 0 && (
                <span className="flex shrink-0 items-center gap-1">
                  {(feed?.summary.critical ?? 0) > 0 && (
                    <Badge
                      variant="danger"
                      size="sm"
                      dot
                      title={t("dashboard.critical")}
                      aria-label={`${feed?.summary.critical} ${t("dashboard.critical")}`}
                    >
                      {feed?.summary.critical}
                    </Badge>
                  )}
                  {(feed?.summary.warning ?? 0) > 0 && (
                    <Badge
                      variant="warning"
                      size="sm"
                      dot
                      title={t("dashboard.warning")}
                      aria-label={`${feed?.summary.warning} ${t("dashboard.warning")}`}
                    >
                      {feed?.summary.warning}
                    </Badge>
                  )}
                  {restockSoon.length > 0 && (
                    <Badge
                      variant="info"
                      size="sm"
                      dot
                      title={t("dashboard.restockSoon")}
                      aria-label={`${restockSoon.length} ${t("dashboard.restockSoon")}`}
                    >
                      {restockSoon.length}
                    </Badge>
                  )}
                </span>
              )}
            </div>
          )}

          {/* ── Body ── */}
          <div className="max-h-[60dvh] overflow-y-auto overscroll-contain">
            {status === "loading" ? (
              <div className="space-y-3 px-4 py-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-2 w-2 rounded-full" />
                    <div className="skeleton h-3.5 flex-1 rounded" />
                  </div>
                ))}
              </div>
            ) : status === "error" ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <span className="neu-inset-sm flex h-9 w-9 items-center justify-center rounded-full">
                  <svg
                    className="h-4 w-4 text-neu-ink-red"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                    />
                  </svg>
                </span>
                <p className="text-sm font-medium text-neu-primary">{t("common.loadFailed")}</p>
                <p className="text-xs text-neu-faint">{error ?? t("common.loadFailedDesc")}</p>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => void refresh()}
                  className="neu-focus mt-1 rounded-lg text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong"
                >
                  {t("common.retry")}
                </button>
              </div>
            ) : disabled ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <span className="neu-inset-sm flex h-9 w-9 items-center justify-center rounded-full">
                  <svg
                    className="h-4 w-4 text-neu-muted"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.143 17.082a24.248 24.248 0 003.844.148m-3.844-.148a23.856 23.856 0 01-5.455-1.31 8.964 8.964 0 002.3-5.542m3.155 6.852a3 3 0 005.667 1.97m1.965-2.277V9.75a6 6 0 00-8.964-5.196m8.964 5.196V9a6 6 0 00-3.036-5.196"
                    />
                  </svg>
                </span>
                <p className="text-sm font-medium text-neu-primary">{t("header.alertsOff")}</p>
                <p className="max-w-[15rem] text-xs text-neu-faint">{t("header.alertsOffHint")}</p>
                <Link
                  role="menuitem"
                  href="/settings"
                  onClick={() => setOpen(false)}
                  className="neu-focus mt-1 rounded-lg text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong"
                >
                  {t("header.openSettings")}
                </Link>
              </div>
            ) : total === 0 ? (
              <div className="px-4 py-8 text-center">
                <span className="neu-inset-sm mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full">
                  <svg
                    className="h-4 w-4 text-neu-ink-green"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </span>
                <p className="text-sm text-neu-faint">{t("header.allStocked")}</p>
              </div>
            ) : (
              <>
                {lowStock.length > 0 && (
                  <div>
                    {lowStock.slice(0, LOW_STOCK_DISPLAY).map((alert) => (
                      <AlertRow
                        key={alert.id}
                        alert={alert}
                        isNew={newAtOpen.has(alert.id)}
                        onNavigate={() => setOpen(false)}
                        t={t}
                      />
                    ))}
                    {lowStock.length > LOW_STOCK_DISPLAY && (
                      <Link
                        role="menuitem"
                        href="/inventory"
                        onClick={() => setOpen(false)}
                        className="neu-focus block border-b border-neu-hairline bg-neu-sunken/60 px-4 py-2 text-center text-xs font-medium text-neu-faint transition-colors hover:text-neu-primary"
                      >
                        +{lowStock.length - LOW_STOCK_DISPLAY} {t("dashboard.moreAlerts")}
                      </Link>
                    )}
                  </div>
                )}

                {restockSoon.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 border-b border-neu-hairline bg-neu-sunken/60 px-4 py-1.5">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">
                        {t("dashboard.restockSoon")}
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-neu-hairline" />
                    </div>
                    {restockSoon.slice(0, RESTOCK_DISPLAY).map((alert) => (
                      <AlertRow
                        key={alert.id}
                        alert={alert}
                        isNew={newAtOpen.has(alert.id)}
                        onNavigate={() => setOpen(false)}
                        t={t}
                      />
                    ))}
                    {restockSoon.length > RESTOCK_DISPLAY && (
                      <Link
                        role="menuitem"
                        href="/inventory"
                        onClick={() => setOpen(false)}
                        className="neu-focus block px-4 py-2 text-center text-xs font-medium text-neu-faint transition-colors hover:text-neu-primary"
                      >
                        +{restockSoon.length - RESTOCK_DISPLAY} {t("dashboard.restockSoon")}
                      </Link>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="flex items-center justify-between gap-2 border-t border-neu-hairline px-4 py-2.5">
            <span
              className={cn(
                "text-[10px]",
                error && status === "ready" ? "text-neu-ink-amber" : "text-neu-faint"
              )}
            >
              {refreshing
                ? t("dashboard.refreshing")
                : error && status === "ready"
                  ? `${t("common.loadFailed")} · ${updatedLabel(lastUpdated, t)}`
                  : updatedLabel(lastUpdated, t)}
            </span>
            <Link
              role="menuitem"
              href="/inventory"
              onClick={() => setOpen(false)}
              className="neu-focus rounded text-xs font-medium text-neu-accent-ink transition-colors hover:text-neu-accent-ink-strong"
            >
              {t("header.viewInventory")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
