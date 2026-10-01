"use client";

import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";
import {
  analytics,
  getHealth,
  healthScore,
  suggestDensity,
  estimateReceiptLengthMm,
  rollDaysRemaining,
  type PrintAnalytics,
  type DensityMode,
} from "@/lib/print/print-intelligence";
import { resetPrintQueues } from "@/lib/print/print-service";
import type { PrinterProfile } from "@prisma/client";

/* ═══════════════════════════════════════════════════════════════
   PRINT CENTER — the command-center dashboard for the print fleet:
   live per-profile health (success rate, last error), 24 h print
   analytics (by kind/profile, top errors), and the paper-economy
   panel (density suggestions + roll-days forecast). Refreshes on a
   timer; all intelligence comes from lib/print/print-intelligence.
   ═══════════════════════════════════════════════════════════════ */

export default function PrintCenterPage() {
  const { t, dir } = useI18n();
  const [profiles, setProfiles] = React.useState<PrinterProfile[]>([]);
  const [stats, setStats] = React.useState<PrintAnalytics | null>(null);
  const [dailyVolume, setDailyVolume] = React.useState(80);
  const [avgItems, setAvgItems] = React.useState(6);
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    const load = () =>
      fetch("/api/printer-profiles")
        .then((r) => r.json())
        .then((d) => setProfiles(d.profiles ?? []))
        .catch(() => undefined);
    load();
    // Health/analytics live client-side; poll for freshness.
    const timer = setInterval(() => {
      setStats(analytics());
      setTick((n) => n + 1);
    }, 5000);
    setStats(analytics());
    return () => clearInterval(timer);
  }, []);

  const rollDays = rollDaysRemaining(dailyVolume, avgItems);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("printCenter.title")}
        description={t("printCenter.description")}
        breadcrumbs={[{ label: t("settings.title"), href: "/settings" }, { label: t("printCenter.breadcrumb") }]}
        actions={
          <Button variant="secondary" size="sm" onClick={() => { resetPrintQueues(); setStats(analytics()); setTick((n) => n + 1); }}>
            {t("printCenter.refresh")}
          </Button>
        }
      />

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={t("printCenter.successRate")} value={stats ? `${stats.successRate}%` : "—"} tone={stats && stats.successRate < 90 ? "warning" : "success"} />
        <Kpi label={t("printCenter.totalPrints")} value={stats ? String(stats.total) : "—"} />
        <Kpi label={t("printCenter.failed")} value={stats ? String(stats.failed) : "0"} tone={stats && stats.failed > 0 ? "negative" : "success"} />
        <Kpi
          label={t("printCenter.rollDays")}
          value={rollDays === null ? "—" : `${rollDays} ${t("printCenter.days")}`}
          tone={rollDays !== null && rollDays < 7 ? "negative" : "default"}
        />
      </div>

      {/* Fleet health */}
      <Card>
        <CardHeader>
          <CardTitle>{t("printCenter.fleetHealth")}</CardTitle>
          <CardDescription>{t("printCenter.fleetHealthDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {profiles.length === 0 ? (
            <EmptyState title={t("printerProfiles.none")} description={t("printerProfiles.noneDesc")} />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {profiles.map((p) => {
                const score = healthScore(p.id);
                const h = getHealth(p.id);
                const state = !p.isEnabled ? "disabled" : score <= 0 ? "down" : score < 80 ? "degraded" : "healthy";
                return (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border border-neu-hairline p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neu-primary" title={`${p.name}`}>{p.name}</p>
                      <p className="text-xs text-neu-faint">
                        {p.paperWidthMm}mm · {p.printableDots} dots · {p.connectionType}
                        {h.lastError ? ` · ${h.lastError.code}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2" dir={dir === "rtl" ? "ltr" : undefined}>
                      <span className="text-sm font-semibold tabular-nums text-neu-primary">{p.isEnabled ? `${score}%` : "—"}</span>
                      <Badge variant={state === "healthy" ? "success" : state === "degraded" ? "warning" : state === "down" ? "danger" : "default"} size="sm">
                        {t(`printCenter.state.${state}`)}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top errors */}
        <Card>
          <CardHeader>
            <CardTitle>{t("printCenter.topErrors")}</CardTitle>
            <CardDescription>{t("printCenter.topErrorsDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {stats && stats.topErrors.length > 0 ? (
              <ul className="space-y-2">
                {stats.topErrors.map((e) => (
                  <li key={e.code} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-neu-primary">{e.code}</span>
                    <span className="tabular-nums text-neu-muted">×{e.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neu-muted">{t("printCenter.noErrors")}</p>
            )}
          </CardContent>
        </Card>

        {/* Paper economy */}
        <Card>
          <CardHeader>
            <CardTitle>{t("printCenter.paperEconomy")}</CardTitle>
            <CardDescription>{t("printCenter.paperEconomyDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <label className="flex-1">
                <span className="mb-1 block text-xs text-neu-faint">{t("printCenter.dailyReceipts")}</span>
                <input
                  type="number" min={0} value={dailyVolume}
                  onChange={(e) => setDailyVolume(Math.max(0, Number(e.target.value)))}
                  className="h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary"
                />
              </label>
              <label className="flex-1">
                <span className="mb-1 block text-xs text-neu-faint">{t("printCenter.avgItems")}</span>
                <input
                  type="number" min={1} value={avgItems}
                  onChange={(e) => setAvgItems(Math.max(1, Number(e.target.value)))}
                  className="h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary"
                />
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {(["compact", "normal", "roomy"] as DensityMode[]).map((mode) => (
                <div key={mode} className="rounded-lg bg-neu-sunken p-2">
                  <p className="text-xs text-neu-faint">{t(`printCenter.density.${mode}`)}</p>
                  <p className="text-sm font-semibold tabular-nums text-neu-primary">
                    {estimateReceiptLengthMm(avgItems, mode)} mm
                  </p>
                </div>
              ))}
            </div>
            <p className="text-sm text-neu-muted">
              {t("printCenter.densitySuggestion")}: <strong className="text-neu-primary">{t(`printCenter.density.${suggestDensity(avgItems)}`)}</strong>
              {rollDays !== null && (
                <> · {t("printCenter.rollForecast")}: <strong className={rollDays < 7 ? "text-neu-ink-red" : "text-neu-ink-green"}>{rollDays} {t("printCenter.days")}</strong></>
              )}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" | "warning" | "negative" }) {
  const color =
    tone === "success"
      ? "text-neu-ink-green"
      : tone === "warning"
        ? "text-neu-ink-amber"
        : tone === "negative"
          ? "text-neu-ink-red"
          : "text-neu-primary";
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-neu-faint">{label}</p>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
