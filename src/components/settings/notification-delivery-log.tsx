"use client";

import * as React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useI18n } from "@/components/providers/i18n-provider";
import { alertKindLabel, auditAlertForEntry, type DeliveryEntry } from "@/lib/notifications/alert-utils";
import { AlertTileInline } from "@/components/ui/alert-tile";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATION DELIVERY LOG (settings card)
   Reads /api/notifications/log — the StockAlertLog rows the throttled
   notifier writes once per (product, warehouse) — and shows when each
   item last triggered an alert, at what quantity/severity, and how
   many times it has fired.

   It deliberately shows the CHANNEL context alongside the rows: the
   log records scan+delivery attempts, so if no external channel is
   configured the entries still exist but nothing left the building.
   Saying that plainly (instead of implying a delivery happened) is
   the difference between a useful log and a misleading one.
   ═══════════════════════════════════════════════════════════════ */

interface DeliveryLogResponse {
  log: DeliveryEntry[];
  channels: { webhook: boolean; email: boolean; inApp: boolean } | null;
  cooldownHours: number | null;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-neu-solid-red",
  warning: "bg-neu-solid-amber",
  info: "bg-neu-solid-cyan",
};

const SEVERITY_BADGE: Record<string, "danger" | "warning" | "info"> = {
  critical: "danger",
  warning: "warning",
  info: "info",
};

/** Reuses the settings job-relative wording so all ages read the same. */
function relativeTime(iso: string, t: (key: string) => string): string {
  const ago = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.floor(ago / 60000);
  if (mins < 1) return t("settings.jobJustNow");
  if (mins < 60) return t("settings.jobMinsAgo").replace("{n}", String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("settings.jobHoursAgo").replace("{n}", String(hours));
  return t("settings.deliveryDaysAgo").replace("{n}", String(Math.floor(hours / 24)));
}

function ChannelChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        on
          ? "border-neu-ink-green/25 bg-neu-wash-green text-neu-ink-green"
          : "border-neu-hairline bg-neu-sunken text-neu-faint"
      )}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-neu-solid-green" : "bg-neu-muted")}
      />
      {label}
    </span>
  );
}

export function NotificationDeliveryLog() {
  const { t } = useI18n();
  const [data, setData] = React.useState<DeliveryLogResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch("/api/notifications/log?limit=25");
      if (!res.ok) throw new Error(`status ${res.status}`);
      setData((await res.json()) as DeliveryLogResponse);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const channels = data?.channels ?? null;
  // The log records scan+delivery ATTEMPTS. With no external channel on,
  // nothing actually leaves the store — say so instead of implying a send.
  const noExternalChannels = channels !== null && !channels.webhook && !channels.email;
  const cooldown = data?.cooldownHours;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{t("settings.deliveryLogTitle")}</CardTitle>
            <CardDescription>{t("settings.deliveryLogDesc")}</CardDescription>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}>
            {t("dashboard.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Channel context — what an entry actually means right now. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-neu-faint">{t("settings.deliveryChannels")}</span>
          <ChannelChip label={t("settings.channelWebhook")} on={!!channels?.webhook} />
          <ChannelChip label={t("settings.channelEmail")} on={!!channels?.email} />
          <ChannelChip label={t("settings.channelInApp")} on={!!channels?.inApp} />
          {typeof cooldown === "number" && (
            <span className="text-xs text-neu-faint">
              {t("settings.deliveryCooldown").replace("{hours}", String(cooldown))}
            </span>
          )}
        </div>

        {noExternalChannels && (
          <p className="rounded-lg border border-neu-ink-amber/25 bg-neu-wash-amber px-3 py-2 text-xs text-neu-ink-amber">
            {t("settings.deliveryNoChannels")}
          </p>
        )}

        {loading && !data ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="skeleton h-2 w-2 rounded-full" />
                <div className="skeleton h-4 flex-1 rounded" />
                <div className="skeleton h-4 w-16 rounded" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <EmptyState
            bare
            error
            icon={
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            }
            title={t("common.loadFailed")}
            description={t("common.loadFailedDesc")}
            action={
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : (data?.log.length ?? 0) === 0 ? (
          <EmptyState
            bare
            icon={
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
            }
            title={t("settings.deliveryLogEmpty")}
            description={t("settings.deliveryLogEmptyHint")}
          />
        ) : (
          <ul className="divide-y divide-neu-hairline">
            {data!.log.map((entry) => {
              const severity = entry.severity ?? "info";
              const alert = auditAlertForEntry(entry, severity);
              return (
                <li key={entry.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      SEVERITY_DOT[severity] ?? "bg-neu-solid-cyan"
                    )}
                  />
                  <AlertTileInline
                    alert={alert}
                    t={t}
                  />
                  <div className="shrink-0 text-end">
                    <p className="text-sm font-semibold tabular-nums text-neu-primary" title={t("settings.deliveryRemaining")}>
                      {entry.lastQuantity} {t("settings.deliveryUnitPlural")}
                    </p>
                    <p className="mt-0.5 text-[11px] text-neu-faint">
                      {entry.attempts > 0
                        ? t("settings.deliverySends").replace("{n}", String(entry.attempts))
                        : t("settings.deliveryNeverFired")}
                      {" · "}
                      {relativeTime(entry.lastAlertedAt, t)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
