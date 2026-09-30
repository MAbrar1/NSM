"use client";

import { useI18n } from "@/components/providers/i18n-provider";
import { StatCard, type StatTone } from "@/components/ui/stat-card";

/* ═══════════════════════════════════════════════════════════════
   TOTAL PRODUCTS CARD
   The catalog-size KPI, shown on both the Dashboard and the
   Reports → Inventory page.

   The two surfaces used to hand-roll this tile from their own i18n
   keys — the Dashboard read `dashboard.totalProducts` ("Products")
   while the report read `reports.totalProducts` — so the same number
   appeared under two different names and the wording drifted. This
   component now owns the label, icon and sub-caption, so callers
   supply only the count (and a tone, since each page tints its grid
   differently). The count ticks between refreshes via StatCard's
   numericValue path.
   ═══════════════════════════════════════════════════════════════ */

export function TotalProductsCard({ value, tone = "info" }: { value: number; tone?: StatTone }) {
  const { t } = useI18n();
  return (
    <StatCard
      label={t("dashboard.totalProducts")}
      value={String(value)}
      numericValue={value}
      formatValue={(v) => String(Math.round(v))}
      icon="box"
      tone={tone}
      sub={t("dashboard.activeInCatalog")}
    />
  );
}
