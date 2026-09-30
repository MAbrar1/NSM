"use client";

import * as React from "react";
import { formatCurrency, cn, percentDelta } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { DonutChart } from "@/components/ui/chart";
import { StatCard } from "@/components/ui/stat-card";
import { downloadCsv, downloadExcel, sumFormulaCell, type ExcelSheet } from "@/lib/files/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { fetchReportSettings, printReport } from "@/lib/print-report";
import { toast } from "@/stores/toast-store";

/* ═══════════════════════════════════════════════════════════════
   PROFIT & LOSS REPORT PAGE
   ═══════════════════════════════════════════════════════════════ */

interface PnLData {
  summary: {
    totalRevenue: number;
    totalCOGS: number;
    grossProfit: number;
    grossMargin: number;
    totalTax: number;
    totalDiscounts: number;
    totalOrders: number;
    averageOrderValue: number;
  };
  monthlyData: Array<{
    month: string;
    revenue: number;
    cogs: number;
    grossProfit: number;
    orders: number;
    averageOrderValue: number;
  }>;
  categoryProfitability: Array<{
    name: string;
    revenue: number;
    cogs: number;
    grossProfit: number;
    margin: number;
    quantity: number;
  }>;
  paymentBreakdown: Array<{ method: string; total: number; count: number }>;
}

const PRESETS = [
  { key: "thisMonth", days: 0 },
  { key: "last30", days: 30 },
  { key: "last90", days: 90 },
  { key: "year", days: 365 },
] as const;

// Payment-method series fills. `--neu-ink-*` (mode-aware, >= 3:1 as a graphic
// on `--neu-bg` in both modes) rather than `--neu-solid-*`, which is tuned for
// white glyphs ON the fill and only scores 2.26:1 against dark `--neu-bg`.
const PAYMENT_COLORS = ["var(--neu-accent-line)", "var(--neu-ink-green)", "var(--neu-ink-amber)", "var(--neu-ink-red)", "var(--neu-ink-violet)"];

export default function ProfitLossPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [data, setData] = React.useState<PnLData | null>(null);
  const [prevSummary, setPrevSummary] = React.useState<PnLData["summary"] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [activePreset, setActivePreset] = React.useState(0);
  const [dateFrom, setDateFrom] = React.useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0]);
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

    Promise.all([fetch(`/api/reports/profit-loss?${params}`), fetch(`/api/reports/profit-loss?${prevParams}`)])
      .then(([res, prevRes]) => Promise.all([res.json(), prevRes.json()]))
      .then(([current, previous]) => {
        setData(current);
        setPrevSummary(previous?.summary ?? null);
        setLoadError(false);
      })
      .catch((e) => {
        console.error(e);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, reloadKey]);

  function applyPreset(days: number) {
    setActivePreset(days);
    const now = new Date();
    if (days === 0) {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      setDateFrom(first.toISOString().split("T")[0]);
    } else {
      setDateFrom(new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0]);
    }
    setDateTo(now.toISOString().split("T")[0]);
  }

  const paymentDonut = (data?.paymentBreakdown ?? []).map((p, i) => ({
    label: t(`pos.paymentMethod.${p.method}`), value: p.total, color: PAYMENT_COLORS[i % PAYMENT_COLORS.length]!,
  }));
  const categoryProfitColumns: ExportColumn<PnLData["categoryProfitability"][number]>[] = [
    { header: "category", value: (c) => c.name, print: { strong: true } },
    {
      header: "revenue", value: (c) => (c.revenue / 100).toFixed(2), excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.revenue, 0)) },
    },
    {
      header: "cogs", value: (c) => (c.cogs / 100).toFixed(2), excelStyle: "money",
      print: { align: "right", muted: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.cogs, 0)) },
    },
    {
      header: "grossProfit", value: (c) => (c.grossProfit / 100).toFixed(2), excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.grossProfit, 0)) },
    },
    { header: "margin", value: (c) => `${c.margin}%`, print: { align: "right" } },
    { header: "quantity", value: (c) => String(c.quantity), excelStyle: "int", omitPrint: true },
  ];

  // Monthly trend rows (printed + Excel)
  const monthlyColumns: ExportColumn<PnLData["monthlyData"][number]>[] = [
    { header: "month", value: (m) => m.month, print: { width: "16%", strong: true } },
    {
      header: "revenue", value: (m) => (m.revenue / 100).toFixed(2), excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.revenue, 0)) },
    },
    {
      header: "cogs", value: (m) => (m.cogs / 100).toFixed(2), excelStyle: "money",
      print: { align: "right", muted: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.cogs, 0)) },
    },
    {
      header: "grossProfit", value: (m) => (m.grossProfit / 100).toFixed(2), excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.grossProfit, 0)) },
    },
    { header: "orders", value: (m) => String(m.orders), excelStyle: "int", print: { align: "right" } },
    { header: "avgOrderValue", value: (m) => (m.averageOrderValue / 100).toFixed(2), excelStyle: "money", print: { align: "right" } },
  ];

  // Excel workbook: Statement + Monthly + Categories
  function exportExcel() {
    if (!data) return;
    const sheets: ExcelSheet[] = [
      {
        name: "P&L Statement",
        headers: ["line", "amount"],
        rows: [
          ["revenue", { v: (data.summary.totalRevenue / 100).toFixed(2), style: "money" as const }],
          ["cogs", { v: (data.summary.totalCOGS / 100).toFixed(2), style: "money" as const }],
          ["grossProfit", { v: (data.summary.grossProfit / 100).toFixed(2), style: "money" as const }],
          ["grossMargin", { v: `${data.summary.grossMargin}%` }],
          ["totalDiscounts", { v: (data.summary.totalDiscounts / 100).toFixed(2), style: "money" as const }],
          ["taxCollected", { v: (data.summary.totalTax / 100).toFixed(2), style: "money" as const }],
          ["totalOrders", { v: data.summary.totalOrders, style: "int" as const }],
          ["averageOrderValue", { v: (data.summary.averageOrderValue / 100).toFixed(2), style: "money" as const }],
        ],
      },
      {
        name: "Monthly",
        headers: monthlyColumns.map((c) => c.header),
        rows: data.monthlyData.map((r) =>
          monthlyColumns.map((c) => {
            const v = c.value(r);
            return c.excelStyle ? { v, style: c.excelStyle } : v;
          })
        ),
        totals: monthlyColumns.map((c, idx) => {
          if (!c.print?.total) return null;
          if (c.excelStyle === "money" || c.excelStyle === "int") {
            return sumFormulaCell(idx, data.monthlyData.length, c.excelStyle === "money" ? "money-bold" : "int-bold");
          }
          return { v: c.print.total(data.monthlyData), style: "bold" as const };
        }),
      },
      {
        name: "Categories",
        headers: categoryProfitColumns.filter((c) => !c.omitExcel).map((c) => c.header),
        rows: data.categoryProfitability.map((r) =>
          categoryProfitColumns.filter((c) => !c.omitExcel).map((c) => {
            const v = c.value(r);
            return c.excelStyle ? { v, style: c.excelStyle } : v;
          })
        ),
        totals: (() => {
          const cols = categoryProfitColumns.filter((c) => !c.omitExcel);
          return cols.map((c, idx) => {
            if (!c.print?.total) return idx === 0 ? { v: t("export.total"), style: "bold" as const } : null;
            if (c.excelStyle === "money" || c.excelStyle === "int") {
              return sumFormulaCell(idx, data.categoryProfitability.length, c.excelStyle === "money" ? "money-bold" : "int-bold");
            }
            return { v: c.print.total(data.categoryProfitability), style: "bold" as const };
          });
        })(),
      },
    ];
    downloadExcel("profit-loss", sheets);
  }

  // CSV: statement + monthly files
  function exportCSV() {
    if (!data) return;
    downloadCsv("profit-loss-statement", ["line", "amount"], [
      ["revenue", (data.summary.totalRevenue / 100).toFixed(2)],
      ["cogs", (data.summary.totalCOGS / 100).toFixed(2)],
      ["grossProfit", (data.summary.grossProfit / 100).toFixed(2)],
      ["grossMargin", `${data.summary.grossMargin}%`],
      ["totalDiscounts", (data.summary.totalDiscounts / 100).toFixed(2)],
      ["taxCollected", (data.summary.totalTax / 100).toFixed(2)],
      ["totalOrders", String(data.summary.totalOrders)],
      ["averageOrderValue", (data.summary.averageOrderValue / 100).toFixed(2)],
    ]);
    downloadCsv(
      "profit-loss-monthly",
      monthlyColumns.map((c) => c.header),
      data.monthlyData.map((r) => monthlyColumns.map((c) => c.value(r)))
    );
  }

  // Printed A4 P&L statement: letterhead, KPIs, statement table,
  // monthly trend and category profitability sections.
  const printPnL = async () => {
    if (!data) return;
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("reports.pnlStatement"),
        kicker: t("reports.profitLoss"),
        periodLabel: `${dateFrom} → ${dateTo}`,
        kpis: [
          { label: t("reports.totalRevenue"), value: formatCurrency(data.summary.totalRevenue), tone: "positive" },
          {
            label: t("reports.grossProfit"),
            value: formatCurrency(data.summary.grossProfit),
            tone: data.summary.grossProfit >= 0 ? "positive" : "negative",
          },
          { label: t("reports.grossMargin"), value: `${data.summary.grossMargin}%` },
          { label: t("reports.totalOrders"), value: String(data.summary.totalOrders) },
        ],
        meta: [
          { label: t("reports.revenueSales"), value: formatCurrency(data.summary.totalRevenue) },
          { label: t("reports.lessCOGS"), value: formatCurrency(data.summary.totalCOGS) },
          { label: t("reports.totalDiscounts"), value: formatCurrency(data.summary.totalDiscounts) },
          { label: t("reports.taxCollected"), value: formatCurrency(data.summary.totalTax) },
          { label: t("reports.avgOrderValue"), value: formatCurrency(data.summary.averageOrderValue) },
        ],
        sections: [
          {
            title: t("reports.monthlyRevProfit"),
            columns: monthlyColumns.map((c) => ({
              label: c.print?.label ?? c.header,
              align: c.print?.align,
              width: c.print?.width,
              strong: c.print?.strong,
              muted: c.print?.muted,
              value: (row: PnLData["monthlyData"][number]) => String(c.value(row) ?? ""),
              total: c.print?.total,
            })),
            rows: data.monthlyData,
            totalsLabel: t("reports.totalRevenue"),
          },
          {
            title: t("reports.categoryProfitability"),
            columns: categoryProfitColumns.map((c) => ({
              label: c.print?.label ?? c.header,
              align: c.print?.align,
              width: c.print?.width,
              strong: c.print?.strong,
              muted: c.print?.muted,
              value: (row: PnLData["categoryProfitability"][number]) => String(c.value(row) ?? ""),
              total: c.print?.total,
            })),
            rows: data.categoryProfitability,
            totalsLabel: t("reports.grossProfit"),
          },
        ],
        footnote: t("reports.pnlDesc"),
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("reports.profitLoss")}
        description={t("reports.pnlDesc")}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("nav.reportsLabel"), href: "/reports" },
          { label: t("reports.profitLoss") },
        ]}
        actions={
          <ExportMenu
            fileStem="profit-loss"
            sheetName="Profit & Loss"
            rows={data?.categoryProfitability ?? []}
            columns={categoryProfitColumns}
            customItems={[
              { label: t("reports.exportCSV"), icon: "csv", onSelect: exportCSV },
              { label: t("export.excelSheets"), icon: "excel", onSelect: exportExcel },
            ]}
            period={`${dateFrom} → ${dateTo}`}
            printKicker="Profit & Loss Statement"
            printTotalsLabel={t("reports.grossProfit")}
            onPrint={printPnL}
            disabled={!data}
          />
        }
      />

      {/* Date Filter */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1">
              {PRESETS.map((preset, i) => (
                <button key={preset.key} onClick={() => applyPreset(preset.days)}
                  className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    activePreset === i ? "bg-neu-accent-solid text-white" : "bg-neu-sunken text-neu-muted"
                  )}>{t(`reports.preset.${preset.key}`)}</button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setActivePreset(-1); }}
                className="h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary" />
              <span className="text-sm text-neu-faint">{t("reports.to")}</span>
              <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setActivePreset(-1); }}
                className="h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary" />
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
      ) : data ? (
        <>
          {/* Summary StatCards with period-over-period deltas */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={t("reports.totalRevenue")}
              value={formatCurrency(data.summary.totalRevenue)}
              numericValue={data.summary.totalRevenue}
              icon="cash"
              tone="brand"
              delta={prevSummary ? percentDelta(data.summary.totalRevenue, prevSummary.totalRevenue) : null}
              deltaLabel={t("reports.vsPrevPeriod")}
            />
            <StatCard
              label={t("reports.grossProfit")}
              value={formatCurrency(data.summary.grossProfit)}
              numericValue={data.summary.grossProfit}
              icon="trend"
              tone={data.summary.grossProfit >= 0 ? "success" : "danger"}
              delta={prevSummary ? percentDelta(data.summary.grossProfit, prevSummary.grossProfit) : null}
              deltaLabel={t("reports.vsPrevPeriod")}
              sub={`${data.summary.grossMargin}% ${t("reports.grossMargin")}`}
            />
            <StatCard
              label={t("reports.totalOrders")}
              value={String(data.summary.totalOrders)}
              numericValue={data.summary.totalOrders}
              formatValue={(v) => String(Math.round(v))}
              icon="bag"
              tone="info"
              delta={prevSummary ? percentDelta(data.summary.totalOrders, prevSummary.totalOrders) : null}
              deltaLabel={t("reports.vsPrevPeriod")}
            />
            <StatCard
              label={t("reports.avgOrderValue")}
              value={formatCurrency(data.summary.averageOrderValue)}
              numericValue={data.summary.averageOrderValue}
              icon="chart"
              tone="warning"
              delta={prevSummary ? percentDelta(data.summary.averageOrderValue, prevSummary.averageOrderValue) : null}
              deltaLabel={t("reports.vsPrevPeriod")}
            />
          </div>

          {/* P&L Statement */}
          <Card>
            <CardHeader><CardTitle>{t("reports.pnlStatement")}</CardTitle></CardHeader>
            <CardContent>
              <div className="max-w-lg space-y-3">
                <div className="flex justify-between py-2">
                  <span className="text-sm font-medium text-neu-muted">{t("reports.revenueSales")}</span>
                  <span className="text-sm font-semibold text-neu-primary">{formatCurrency(data.summary.totalRevenue)}</span>
                </div>
                <div className="flex justify-between py-2 border-t border-neu-hairline">
                  <span className="text-sm text-neu-faint">{t("reports.lessCOGS")}</span>
                  <span className="text-sm text-neu-ink-red">({formatCurrency(data.summary.totalCOGS)})</span>
                </div>
                <div className="flex justify-between py-3 border-t-2 border-neu-hairline">
                  <span className="text-base font-bold text-neu-primary">{t("reports.grossProfit")}</span>
                  <span className={cn("text-base font-bold", data.summary.grossProfit >= 0 ? "text-neu-ink-green" : "text-neu-ink-red")}>
                    {formatCurrency(data.summary.grossProfit)}
                  </span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-xs text-neu-faint">{t("reports.grossMargin")}</span>
                  <Badge variant={data.summary.grossMargin >= 30 ? "success" : data.summary.grossMargin >= 15 ? "warning" : "danger"} size="sm">
                    {data.summary.grossMargin}%
                  </Badge>
                </div>

                <div className="border-t border-neu-hairline pt-3 mt-3 space-y-2">
                  <h4 className="text-xs font-semibold uppercase text-neu-faint">{t("reports.additionalInfo")}</h4>
                  <div className="flex justify-between text-sm">
                    <span className="text-neu-faint">{t("reports.totalDiscounts")}</span>
                    <span className="text-neu-ink-amber">{formatCurrency(data.summary.totalDiscounts)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-neu-faint">{t("reports.taxCollected")}</span>
                    <span className="text-neu-primary">{formatCurrency(data.summary.totalTax)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-neu-faint">{t("reports.totalOrders")}</span>
                    <span className="text-neu-primary">{data.summary.totalOrders}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-neu-faint">{t("reports.avgOrderValue")}</span>
                    <span className="font-semibold text-neu-primary">{formatCurrency(data.summary.averageOrderValue)}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Charts Row */}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle>{t("reports.monthlyRevProfit")}</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1">
                  <div className="flex items-center gap-4 text-xs text-neu-faint mb-2">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-neu-accent-solid" /> {t("reports.revenue")}</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-neu-solid-green" /> {t("reports.grossProfit")}</span>
                  </div>
                  {/* Simple stacked bar */}
                  <div className="space-y-3">
                    {data.monthlyData.map((m) => (
                      <div key={m.month} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neu-muted">{m.month}</span>
                          <span className="font-medium text-neu-primary">{formatCurrency(m.grossProfit)}</span>
                        </div>
                        <div className="h-6 rounded-md bg-neu-sunken overflow-hidden flex">
                          <div className="h-full bg-neu-accent-line/80 transition-all" style={{ width: `${data.summary.totalRevenue > 0 ? (m.revenue / data.summary.totalRevenue) * 100 : 0}%` }} />
                        </div>
                        <div className="h-3 rounded-md bg-neu-sunken overflow-hidden">
                          <div className="h-full bg-neu-solid-green/80 transition-all" style={{ width: `${data.summary.totalRevenue > 0 ? (m.grossProfit / data.summary.totalRevenue) * 100 : 0}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>{t("reports.revenueByPayment")}</CardTitle></CardHeader>
              <CardContent className="flex justify-center">
                <DonutChart data={paymentDonut} />
              </CardContent>
            </Card>
          </div>

          {/* Category Profitability */}
          <Card>
            <CardHeader><CardTitle>{t("reports.categoryProfitability")}</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-neu-hairline">
                      <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-neu-faint">{t("products.category")}</th>
                      <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.revenue")}</th>
                      <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.cogs")}</th>
                      <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.grossProfit")}</th>
                      <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.margin")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neu-hairline">
                    {data.categoryProfitability.map((cat) => (
                      <tr key={cat.name} className="hover:bg-neu-sunken/50">
                        <td className="px-3 py-2.5 text-sm font-medium text-neu-primary">{cat.name}</td>
                        <td className="px-3 py-2.5 text-end text-sm text-neu-primary">{formatCurrency(cat.revenue)}</td>
                        <td className="px-3 py-2.5 text-end text-sm text-neu-ink-red">{formatCurrency(cat.cogs)}</td>
                        <td className={cn("px-3 py-2.5 text-end text-sm font-semibold", cat.grossProfit >= 0 ? "text-neu-ink-green" : "text-neu-ink-red")}>
                          {formatCurrency(cat.grossProfit)}
                        </td>
                        <td className="px-3 py-2.5 text-end">
                          <Badge variant={cat.margin >= 30 ? "success" : cat.margin >= 15 ? "warning" : "danger"} size="sm">{cat.margin}%</Badge>
                        </td>
                      </tr>
                    ))}
                    {data.categoryProfitability.length === 0 && (
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
        </>
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
      ) : null}
    </div>
  );
}
