"use client";

import * as React from "react";
import { formatCurrency, cn, percentDelta } from "@/lib/utils";
import { lineQtyLabel } from "@/lib/units";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useI18n } from "@/components/providers/i18n-provider";
import { downloadCsv, downloadExcel, sumFormulaCell, type ExcelSheet } from "@/lib/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { fetchReportSettings, printReport } from "@/lib/print-report";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { StatCard, type StatIconName, type StatTone } from "@/components/ui/stat-card";
import { toast } from "@/stores/toast-store";
import { BarChart, DonutChart } from "@/components/ui/chart";

/* ═══════════════════════════════════════════════════════════════
   SALES REPORT PAGE
   Interactive sales analytics with date range, charts, and export.
   ═══════════════════════════════════════════════════════════════ */

interface SalesData {
  summary: {
    totalRevenue: number;
    totalTax: number;
    totalDiscounts: number;
    netRevenue: number;
    averageOrderValue: number;
    totalOrders: number;
  };
  statusBreakdown: Array<{ status: string; count: number }>;
  topProducts: Array<{
    name: string;
    sku: string;
    unit?: string | null;
    quantitySold: number;
    revenue: number;
    orderCount: number;
  }>;
  categories: Array<{
    name: string;
    revenue: number;
    quantity: number;
    items: number;
  }>;
  dailyTrends: Array<{
    date: string;
    revenue: number;
    orders: number;
    netRevenue: number;
  }>;
  paymentMethods: Array<{
    method: string;
    total: number;
    count: number;
  }>;
}

const PRESETS = [
  { key: "today", days: 0 },
  { key: "last7", days: 7 },
  { key: "last30", days: 30 },
  { key: "last90", days: 90 },
  { key: "year", days: 365 },
] as const;

// Donut series fills. These are drawn ON the page background, so they take
// the mode-aware `--neu-ink-*` roles (>= 3:1 as a graphic in both modes)
// rather than the mode-stable `--neu-solid-*` fills, which are tuned for a
// white glyph on top of them and drop to 2.26:1 on dark `--neu-bg`.
const DONUT_COLORS = [
  "var(--neu-accent-line)",
  "var(--neu-ink-green)",
  "var(--neu-ink-amber)",
  "var(--neu-ink-red)",
  "var(--neu-ink-violet)",
];

export default function SalesReportPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [data, setData] = React.useState<SalesData | null>(null);
  const [prevSummary, setPrevSummary] = React.useState<SalesData["summary"] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [activePreset, setActivePreset] = React.useState(30);
  const [dateFrom, setDateFrom] = React.useState(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
  );
  const [dateTo, setDateTo] = React.useState(new Date().toISOString().split("T")[0]);

  // Fetch report data + the immediately-preceding window of the same
  // length, so each KPI can show a period-over-period delta chip.
  React.useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);

    let prevParams = new URLSearchParams();
    if (dateFrom && dateTo) {
      const from = new Date(dateFrom);
      const to = new Date(dateTo);
      if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to >= from) {
        const spanDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
        const prevTo = new Date(from.getTime() - 86_400_000);
        const prevFrom = new Date(prevTo.getTime() - spanDays * 86_400_000);
        prevParams = new URLSearchParams({
          dateFrom: prevFrom.toISOString().split("T")[0]!,
          dateTo: prevTo.toISOString().split("T")[0]!,
        });
      }
    }

    Promise.all([fetch(`/api/reports/sales?${params}`), fetch(`/api/reports/sales?${prevParams}`)])
      .then(async ([res, prevRes]) => {
        const [current, previous] = await Promise.all([res.json(), prevRes.json()]);
        // Guard against error-shaped or partial responses — never let a
        // backend hiccup crash the report view.
        if (!res.ok || !current?.summary || !prevRes.ok) {
          throw new Error("sales report API error");
        }
        setData(current as SalesData);
        setPrevSummary(previous?.summary ?? null);
        setLoadError(false);
      })
      .catch((e) => {
        console.error(e);
        setData(null);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, reloadKey]);

  // Preset date ranges
  function applyPreset(days: number) {
    setActivePreset(days);
    const now = new Date();
    if (days === 0) {
      const today = now.toISOString().split("T")[0];
      setDateFrom(today);
      setDateTo(today);
    } else {
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      setDateFrom(from.toISOString().split("T")[0]);
      setDateTo(now.toISOString().split("T")[0]);
    }
  }

  // Build the three export sections (summary / products / categories)
  function buildSections() {
    if (!data) return null;
    const summaryRows: Array<Array<string | number>> = [
      ["dateFrom", dateFrom ?? ""],
      ["dateTo", dateTo ?? ""],
      ["totalRevenue", (data.summary.totalRevenue / 100).toFixed(2)],
      ["netRevenue", (data.summary.netRevenue / 100).toFixed(2)],
      ["totalOrders", String(data.summary.totalOrders)],
      ["averageOrderValue", (data.summary.averageOrderValue / 100).toFixed(2)],
      ["totalTax", (data.summary.totalTax / 100).toFixed(2)],
      ["totalDiscounts", (data.summary.totalDiscounts / 100).toFixed(2)],
    ];
    const productRows: Array<Array<string | number>> = data.topProducts.map((p) => [
      p.name, p.sku, lineQtyLabel(p.quantitySold, p.unit) ?? "",
      (p.revenue / 100).toFixed(2), String(p.orderCount),
    ]);
    const categoryRows: Array<Array<string | number>> = data.categories.map((c) => [
      c.name, (c.revenue / 100).toFixed(2), String(c.quantity), String(c.items),
    ]);
    return { summaryRows, productRows, categoryRows };
  }

  // Export to CSV (three focused files — analysis-ready in Excel/Sheets)
  function exportCSV() {
    const sections = buildSections();
    if (!sections) return;
    downloadCsv("sales-report", ["metric", "value"], sections.summaryRows);
    downloadCsv("sales-report-products", ["name", "sku", "qtySold", "revenue", "orders"], sections.productRows);
    downloadCsv("sales-report-categories", ["category", "revenue", "quantity", "items"], sections.categoryRows);
  }

  // Elite single-workbook Excel export: one styled, multi-sheet .xlsx
  // replaces the three loose CSVs for analysts who live in Excel.
  function exportExcel() {
    const sections = buildSections();
    if (!sections) return;
    const sheets: ExcelSheet[] = [
      { name: "Summary", headers: ["metric", "value"], rows: sections.summaryRows },
      {
        name: "Top Products",
        headers: ["name", "sku", "qtySold", "revenue", "orders"],
        rows: sections.productRows.map((r) => [r[0], r[1], r[2], { v: r[3], style: "money" as const }, { v: r[4], style: "int" as const }]),
        totals: [
          { v: t("export.total"), style: "bold" as const },
          null,
          null,
          sumFormulaCell(3, sections.productRows.length, "money-bold"),
          sumFormulaCell(4, sections.productRows.length, "int-bold"),
        ],
      },
      {
        name: "Categories",
        headers: ["category", "revenue", "quantity", "items"],
        rows: sections.categoryRows.map((r) => [r[0], { v: r[1], style: "money" as const }, { v: r[2], style: "int" as const }, { v: r[3], style: "int" as const }]),
        totals: [
          { v: t("export.total"), style: "bold" as const },
          sumFormulaCell(1, sections.categoryRows.length, "money-bold"),
          sumFormulaCell(2, sections.categoryRows.length, "int-bold"),
          sumFormulaCell(3, sections.categoryRows.length, "int-bold"),
        ],
      },
    ];
    downloadExcel("sales-report", sheets);
  }

  // Product export columns (drive the CSV/Excel/print top-products table)
  const productExportColumns: ExportColumn<SalesData["topProducts"][number]>[] = [
    { header: "name", value: (p) => p.name, print: { strong: true } },
    { header: "sku", value: (p) => p.sku, print: { muted: true } },
    { header: "qtySold", value: (p) => lineQtyLabel(p.quantitySold, p.unit) ?? "", excelStyle: "int", print: { label: "Qty Sold", align: "right" } },
    {
      header: "revenue",
      value: (p) => (p.revenue / 100).toFixed(2),
      excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.revenue, 0)) },
    },
    { header: "orders", value: (p) => String(p.orderCount), excelStyle: "int", print: { align: "right" } },
  ];

  // Printed A4 sales report via the shared print engine
  const printSalesReport = async () => {
    if (!data) return;
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("reports.salesReport"),
        kicker: "Sales Analytics",
        periodLabel: `${dateFrom} → ${dateTo}`,
        kpis: [
          { label: t("reports.totalRevenue"), value: formatCurrency(data.summary.totalRevenue), tone: "positive" },
          { label: t("reports.netRevenue"), value: formatCurrency(data.summary.netRevenue) },
          { label: t("reports.totalOrders"), value: String(data.summary.totalOrders) },
          { label: t("reports.avgOrderValue"), value: formatCurrency(data.summary.averageOrderValue) },
        ],
        meta: [
          { label: t("reports.totalTax"), value: formatCurrency(data.summary.totalTax) },
          { label: t("reports.totalDiscounts"), value: formatCurrency(data.summary.totalDiscounts) },
        ],
        sections: [
          {
            title: t("reports.topProducts"),
            columns: productExportColumns.map((c) => ({
              label: c.print?.label ?? c.header,
              align: c.print?.align,
              width: c.print?.width,
              strong: c.print?.strong,
              muted: c.print?.muted,
              value: (row: SalesData["topProducts"][number]) => String(c.value(row) ?? ""),
              total: c.print?.total,
            })),
            rows: data.topProducts,
            totalsLabel: t("reports.totalRevenue"),
          },
          {
            title: t("reports.categoryBreakdown"),
            columns: [
              { label: "Category", value: (c: SalesData["categories"][number]) => c.name, strong: true },
              { label: t("reports.revenue"), align: "right", strong: true, value: (c: SalesData["categories"][number]) => formatCurrency(c.revenue), total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.revenue, 0)) },
              { label: "Qty", align: "right", value: (c: SalesData["categories"][number]) => String(c.quantity) },
              { label: t("reports.items"), align: "right", value: (c: SalesData["categories"][number]) => String(c.items) },
            ],
            rows: data.categories,
          },
          {
            title: t("reports.paymentMethods"),
            columns: [
              { label: "Method", value: (p: SalesData["paymentMethods"][number]) => t(`pos.paymentMethod.${p.method}`), strong: true },
              { label: t("reports.revenue"), align: "right", strong: true, value: (p: SalesData["paymentMethods"][number]) => formatCurrency(p.total), total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.total, 0)) },
              { label: "Orders", align: "right", value: (p: SalesData["paymentMethods"][number]) => String(p.count) },
            ],
            rows: data.paymentMethods,
          },
        ],
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  // Prepare chart data
  const trendData = (data?.dailyTrends ?? []).map((t) => ({
    label: new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    value: t.revenue,
  }));

  const categoryData = (data?.categories ?? []).slice(0, 8).map((c) => ({
    label: c.name,
    value: c.revenue,
  }));

  const paymentDonutData = (data?.paymentMethods ?? []).map((p, i) => ({
    label: t(`pos.paymentMethod.${p.method}`),
    value: p.total,
    color: DONUT_COLORS[i % DONUT_COLORS.length]!,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("reports.salesReport")}
        description={t("reports.salesDesc")}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("nav.reportsLabel"), href: "/reports" },
          { label: t("reports.salesCrumb") },
        ]}
        actions={
          <ExportMenu
            fileStem="sales-report"
            sheetName="Sales Report"
            rows={data?.topProducts ?? []}
            columns={productExportColumns}
            customItems={[{ label: t("reports.exportCSV"), icon: "csv", onSelect: exportCSV }, { label: t("export.excelSheets"), icon: "excel", onSelect: exportExcel }]}
            period={`${dateFrom} → ${dateTo}`}
            onPrint={printSalesReport}
            disabled={!data}
          />
        }
      />

      {/* Date Range Filter */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Presets */}
            <div className="flex gap-1">
              {PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  onClick={() => applyPreset(preset.days)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    activePreset === preset.days
                      ? "bg-neu-accent-solid text-white"
                      : "bg-neu-sunken text-neu-muted"
                  )}
                >
                  {t(`reports.preset.${preset.key}`)}
                </button>
              ))}
            </div>
            {/* Custom dates */}
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setActivePreset(-1); }}
                className="h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary"
              />
              <span className="text-sm text-neu-faint">{t("reports.to")}</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setActivePreset(-1); }}
                className="h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-6"><div className="space-y-2"><div className="skeleton h-4 w-20 rounded" /><div className="skeleton h-8 w-28 rounded" /></div></CardContent></Card>
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          error
          title={t("reports.loadFailed")}
          description={t("reports.loadFailedDesc")}
          icon={
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
          }
          action={
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : data ? (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                {
                  label: t("reports.totalRevenue"),
                  value: formatCurrency(data.summary.totalRevenue),
                  numericValue: data.summary.totalRevenue,
                  icon: "cash" as StatIconName,
                  tone: "brand" as StatTone,
                  delta: prevSummary ? percentDelta(data.summary.totalRevenue, prevSummary.totalRevenue) : null,
                  deltaLabel: t("reports.vsPrevPeriod"),
                  sub: `${formatCurrency(data.summary.totalTax)} ${t("reports.totalTax")}`,
                },
                {
                  label: t("reports.netRevenue"),
                  value: formatCurrency(data.summary.netRevenue),
                  numericValue: data.summary.netRevenue,
                  icon: "trend" as StatIconName,
                  tone: "success" as StatTone,
                  delta: prevSummary ? percentDelta(data.summary.netRevenue, prevSummary.netRevenue) : null,
                  deltaLabel: t("reports.vsPrevPeriod"),
                  sub: `${formatCurrency(data.summary.totalDiscounts)} ${t("reports.totalDiscounts")}`,
                },
                {
                  label: t("reports.totalOrders"),
                  value: String(data.summary.totalOrders),
                  numericValue: data.summary.totalOrders,
                  formatValue: (v: number) => String(Math.round(v)),
                  icon: "bag" as StatIconName,
                  tone: "info" as StatTone,
                  delta: prevSummary ? percentDelta(data.summary.totalOrders, prevSummary.totalOrders) : null,
                  deltaLabel: t("reports.vsPrevPeriod"),
                },
                {
                  label: t("reports.avgOrderValue"),
                  value: formatCurrency(data.summary.averageOrderValue),
                  numericValue: data.summary.averageOrderValue,
                  icon: "chart" as StatIconName,
                  tone: "warning" as StatTone,
                  delta: prevSummary ? percentDelta(data.summary.averageOrderValue, prevSummary.averageOrderValue) : null,
                  deltaLabel: t("reports.vsPrevPeriod"),
                },
              ] as Array<{
                label: string;
                value: string;
                numericValue?: number;
                formatValue?: (v: number) => string;
                icon: StatIconName;
                tone: StatTone;
                delta: number | null;
                deltaLabel: string;
                sub?: string;
              }>
            ).map((stat) => (
              <StatCard
                key={stat.label}
                label={stat.label}
                value={stat.value}
                numericValue={stat.numericValue}
                formatValue={stat.formatValue}
                icon={stat.icon}
                tone={stat.tone}
                delta={stat.delta}
                deltaLabel={stat.deltaLabel}
                sub={stat.sub}
              />
            ))}
          </div>

          {/* Charts Row */}
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Revenue Trend */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>{t("reports.revenueTrend")}</CardTitle>
                  {data && (
                    <div className="flex items-center gap-3 text-xs text-neu-faint">
                      <span className="flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full bg-neu-accent-solid" />
                        {t("reports.revenue")}
                      </span>
                      <span>
                        {data.dailyTrends.reduce((s, d) => s + d.orders, 0)} {t("dashboard.orders")}
                      </span>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <BarChart data={trendData} height={220} />
              </CardContent>
            </Card>

            {/* Payment Methods */}
            <Card>
              <CardHeader>
                <CardTitle>{t("reports.paymentMethods")}</CardTitle>
              </CardHeader>
              <CardContent className="flex justify-center">
                <DonutChart data={paymentDonutData} />
              </CardContent>
            </Card>
          </div>

          {/* Category Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>{t("reports.revenueByCategory")}</CardTitle>
            </CardHeader>
            <CardContent>
              <BarChart data={categoryData} height={180} color="var(--neu-ink-green)" />
            </CardContent>
          </Card>

          {/* Top Products Table */}
          <Card>
            <CardHeader>
              <CardTitle>{t("reports.topProducts")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-neu-hairline">
                      <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-neu-faint">#</th>
                      <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-neu-faint">{t("products.name")}</th>
                      <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.qtySold")}</th>
                      <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.revenue")}</th>
                      <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("orders.total")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neu-hairline">
                    {data.topProducts.map((product, i) => (
                      <tr key={product.sku} className="hover:bg-neu-sunken/50">
                        <td className="px-3 py-2.5">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neu-sunken text-xs font-bold text-neu-muted">
                            {i + 1}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="text-sm font-medium text-neu-primary">{product.name}</p>
                          <p className="text-xs text-neu-faint font-mono">{product.sku}</p>
                        </td>
                        <td className="px-3 py-2.5 text-end text-sm tabular-nums text-neu-primary">{lineQtyLabel(product.quantitySold, product.unit)}</td>
                        <td className="px-3 py-2.5 text-end text-sm font-semibold text-neu-primary">{formatCurrency(product.revenue)}</td>
                        <td className="px-3 py-2.5 text-end text-sm text-neu-muted">{product.orderCount}</td>
                      </tr>
                    ))}
                    {data.topProducts.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-0">
                          <EmptyState bare title={t("reports.noDataPeriod")} />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Status Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>{t("reports.orderStatusSummary")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {data.statusBreakdown.map((s) => (
                  <div key={s.status} className="flex items-center gap-2 rounded-lg bg-neu-sunken px-4 py-2">
                    <Badge variant={s.status === "completed" ? "success" : s.status === "cancelled" ? "danger" : "default"} size="sm">
                      {t(`orders.${s.status}`)}
                    </Badge>
                    <span className="text-sm font-semibold text-neu-primary">{s.count}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
