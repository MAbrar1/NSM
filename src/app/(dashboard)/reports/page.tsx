"use client";

import * as React from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/components/providers/i18n-provider";

/* ═══════════════════════════════════════════════════════════════
   REPORTS HUB
   The "Reports" breadcrumb on every report page and the welcome
   modal both link to /reports — which previously had no route, so
   those links 404'd. This hub is that landing page: one card per
   report, each in the app's neumorphic card style.
   ═══════════════════════════════════════════════════════════════ */

interface ReportLink {
  href: string;
  titleKey: string;
  descKey: string;
  iconPath: string;
}

const REPORTS: ReportLink[] = [
  {
    href: "/reports/sales",
    titleKey: "reports.salesReport",
    descKey: "reports.salesDesc",
    iconPath:
      "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  },
  {
    href: "/reports/inventory",
    titleKey: "reports.inventoryReport",
    descKey: "reports.inventoryDesc",
    iconPath:
      "M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10.5 3v4.5m3-4.5v4.5M3.375 7.5h17.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125H3.375A1.125 1.125 0 012.25 19.875V8.625c0-.621.504-1.125 1.125-1.125z",
  },
  {
    href: "/reports/profit-loss",
    titleKey: "reports.profitLoss",
    descKey: "reports.pnlDesc",
    iconPath:
      "M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941",
  },
];

export default function ReportsPage() {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("nav.reportsLabel")}
        description={t("reports.hubDesc")}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("nav.reportsLabel") },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((report) => (
          <Link key={report.href} href={report.href} className="neu-focus rounded-2xl">
            <Card className="h-full transition-transform duration-200 hover:-translate-y-0.5">
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neu-accent-wash text-neu-accent-ink-strong">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={report.iconPath} />
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold text-neu-primary">{t(report.titleKey)}</h2>
                    <p className="mt-1 text-sm text-neu-muted">{t(report.descKey)}</p>
                    <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-neu-accent-ink">
                      {t("reports.openReport")}
                      <svg className="h-3.5 w-3.5 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
