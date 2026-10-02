"use client";

import * as React from "react";
import { centsToMajorString } from "@/lib/money/money";
import { formatCurrency, cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { BarChart, DonutChart } from "@/components/ui/chart";
import { StatCard } from "@/components/ui/stat-card";
import { TotalProductsCard } from "@/components/ui/total-products-card";
import { downloadCsv, downloadExcel, type ExcelSheet, type XlsxCell } from "@/lib/files/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { fetchReportSettings, printReport } from "@/lib/print/print-report";
import { toast } from "@/stores/toast-store";

/* ═══════════════════════════════════════════════════════════════
   INVENTORY REPORT PAGE
   Stock valuation, turnover rates, aging analysis, and breakdown.
   ═══════════════════════════════════════════════════════════════ */

interface InventoryData {
  summary: {
    totalProducts: number;
    totalQuantity: number;
    totalCostValue: number;
    totalRetailValue: number;
    totalPotentialProfit: number;
    profitMargin: number;
    lowStockCount: number;
    outOfStockCount: number;
    excessStockCount: number;
    deadStockCount: number;
  };
  categoryBreakdown: Array<{
    name: string;
    quantity: number;
    costValue: number;
    retailValue: number;
    items: number;
    margin: number;
  }>;
  warehouseBreakdown: Array<{
    name: string;
    code: string;
    quantity: number;
    costValue: number;
  }>;
  turnoverData: Array<{
    productName: string;
    sku: string;
    category: string;
    currentStock: number;
    soldLast30Days: number;
    dailyRate: number;
    daysOfStock: number;
    turnoverCategory: string;
    stockValue: number;
  }>;
  agingProducts: Array<{
    productName: string;
    sku: string;
    category: string;
    quantity: number;
    value: number;
  }>;
  turnoverSummary: {
    fastMoving: number;
    normal: number;
    slowMoving: number;
    deadStock: number;
  };
}

type Tab = "overview" | "turnover" | "aging";

export default function InventoryReportPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [data, setData] = React.useState<InventoryData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [activeTab, setActiveTab] = React.useState<Tab>("overview");

  React.useEffect(() => {
    setLoadError(false);
    fetch("/api/reports/inventory")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => {
        console.error(e);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [reloadKey]);

  // Chart data
  const categoryChartData = (data?.categoryBreakdown ?? []).slice(0, 8).map((c) => ({
    label: c.name,
    value: c.costValue,
  }));

  const turnoverDonutData = data?.turnoverSummary
    ? [
        // Series fills drawn ON the page background => mode-aware `--neu-ink-*`
        // (>= 3:1 as a graphic in both modes), NOT the mode-stable
        // `--neu-solid-*` fills, which are tuned for a white glyph on top.
        { label: t("reports.turnover.fast"), value: data.turnoverSummary.fastMoving, color: "var(--neu-ink-green)" },
        { label: t("reports.turnover.normal"), value: data.turnoverSummary.normal, color: "var(--neu-accent-line)" },
        { label: t("reports.turnover.slow"), value: data.turnoverSummary.slowMoving, color: "var(--neu-ink-amber)" },
        { label: t("reports.turnover.dead"), value: data.turnoverSummary.deadStock, color: "var(--neu-ink-red)" },
      ]
    : [];

  const turnoverColorMap: Record<string, "success" | "default" | "warning" | "danger"> = {
    "Fast Moving": "success",
    "Normal": "default",
    "Slow Moving": "warning",
    "Dead Stock": "danger",
  };

  function turnoverLabel(category: string): string {
    switch (category) {
      case "Fast Moving": return t("reports.turnover.fast");
      case "Normal": return t("reports.turnover.normal");
      case "Slow Moving": return t("reports.turnover.slow");
      case "Dead Stock": return t("reports.turnover.dead");
      default: return category;
    }
  }


  // ─── Export config: category breakdown drives CSV/Excel/print ───
  const categoryExportColumns: ExportColumn<InventoryData["categoryBreakdown"][number]>[] = [
    { header: "category", value: (c) => c.name, print: { strong: true } },
    { header: "items", value: (c) => String(c.items), excelStyle: "int", print: { align: "right" } },
    { header: "units", value: (c) => String(c.quantity), excelStyle: "int", print: { align: "right" } },
    {
      header: "costValue", value: (c) => centsToMajorString(c.costValue), excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.costValue, 0)) },
    },
    {
      header: "retailValue", value: (c) => centsToMajorString(c.retailValue), excelStyle: "money",
      print: { align: "right", total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.retailValue, 0)) },
    },
    { header: "margin", value: (c) => centsToMajorString(c.margin), excelStyle: "money", print: { align: "right", muted: true } },
  ];

  // Turnover rows (CSV + Excel + printed analysis section)
  const turnoverExportColumns: ExportColumn<InventoryData["turnoverData"][number]>[] = [
    { header: "product", value: (i) => i.productName, print: { strong: true } },
    { header: "sku", value: (i) => i.sku, print: { muted: true } },
    { header: "category", value: (i) => i.category, omitPrint: true },
    { header: "stock", value: (i) => String(i.currentStock), excelStyle: "int", print: { label: "Stock", align: "right" } },
    { header: "sold30d", value: (i) => String(i.soldLast30Days), excelStyle: "int", print: { label: "Sold (30d)", align: "right" } },
    { header: "daysOfStock", value: (i) => (i.daysOfStock >= 999 ? "∞" : String(i.daysOfStock)), print: { label: "Days Left", align: "right" } },
    { header: "turnover", value: (i) => turnoverLabel(i.turnoverCategory), print: { label: "Turnover", align: "center" } },
    {
      header: "stockValue", value: (i) => centsToMajorString(i.stockValue), excelStyle: "money",
      print: { label: "Stock Value", align: "right", total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.stockValue, 0)) },
    },
  ];

  // Aging / dead-stock rows
  const agingExportColumns: ExportColumn<InventoryData["agingProducts"][number]>[] = [
    { header: "product", value: (i) => i.productName, print: { strong: true } },
    { header: "sku", value: (i) => i.sku, print: { muted: true } },
    { header: "category", value: (i) => i.category },
    { header: "quantity", value: (i) => String(i.quantity), excelStyle: "int", print: { align: "right", total: (rows) => String(rows.reduce((s, r) => s + r.quantity, 0)) } },
    {
      header: "valueAtRisk", value: (i) => centsToMajorString(i.value), excelStyle: "money",
      print: { label: "Value at Risk", align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.value, 0)) },
    },
  ];

  // Excel workbook: Summary + Categories + Turnover (+ Aging when present)
  function exportExcel() {
    if (!data) return;
    const sheets: ExcelSheet[] = [
      {
        name: "Summary",
        headers: ["metric", "value"],
        rows: [
          ["totalProducts", { v: data.summary.totalProducts, style: "int" as const }],
          ["totalUnits", { v: data.summary.totalQuantity, style: "int" as const }],
          ["totalCostValue", { v: centsToMajorString(data.summary.totalCostValue), style: "money" as const }],
          ["totalRetailValue", { v: centsToMajorString(data.summary.totalRetailValue), style: "money" as const }],
          ["potentialProfit", { v: centsToMajorString(data.summary.totalPotentialProfit), style: "money" as const }],
          ["profitMargin", { v: `${data.summary.profitMargin}%` }],
          ["lowStockCount", { v: data.summary.lowStockCount, style: "int" as const }],
          ["outOfStockCount", { v: data.summary.outOfStockCount, style: "int" as const }],
          ["deadStockCount", { v: data.summary.deadStockCount, style: "int" as const }],
        ] as XlsxCell[][],
      },
      {
        name: "Categories",
        headers: categoryExportColumns.map((c) => c.header),
        rows: data.categoryBreakdown.map(
          (r): XlsxCell[] => categoryExportColumns.map((c) => {
            const v = c.value(r);
            return c.excelStyle ? { v, style: c.excelStyle } : v;
          })
        ),
      },
      {
        name: "Turnover",
        headers: turnoverExportColumns.filter((c) => !c.omitExcel).map((c) => c.header),
        rows: data.turnoverData.map(
          (r): XlsxCell[] =>
            turnoverExportColumns.filter((c) => !c.omitExcel).map((c) => {
              const v = c.value(r);
              return c.excelStyle ? { v, style: c.excelStyle } : v;
            })
        ),
      },
    ];
    if (data.agingProducts.length > 0) {
      sheets.push({
        name: "Dead Stock",
        headers: agingExportColumns.map((c) => c.header),
        rows: data.agingProducts.map(
          (r): XlsxCell[] => agingExportColumns.map((c) => {
            const v = c.value(r);
            return c.excelStyle ? { v, style: c.excelStyle } : v;
          })
        ),
      });
    }
    downloadExcel("inventory-report", sheets);
  }

  // CSV keeps the analyst three focused files (same as the sales report)
  function exportCSV() {
    if (!data) return;
    downloadCsv(
      "inventory-report-categories",
      categoryExportColumns.map((c) => c.header),
      data.categoryBreakdown.map((r) => categoryExportColumns.map((c) => c.value(r)))
    );
    downloadCsv(
      "inventory-report-turnover",
      turnoverExportColumns.filter((c) => !c.omitExcel).map((c) => c.header),
      data.turnoverData.map((r) => turnoverExportColumns.filter((c) => !c.omitExcel).map((c) => c.value(r)))
    );
    if (data.agingProducts.length > 0) {
      downloadCsv(
        "inventory-report-dead-stock",
        agingExportColumns.map((c) => c.header),
        data.agingProducts.map((r) => agingExportColumns.map((c) => c.value(r)))
      );
    }
  }

  // Printed A4 inventory-valuation report (three sections)
  const printInventoryReport = async () => {
    if (!data) return;
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("reports.inventoryReport"),
        kicker: "Stock Valuation & Turnover",
        kpis: [
          { label: t("reports.stockValueCost"), value: formatCurrency(data.summary.totalCostValue), tone: "positive" },
          { label: t("reports.retailValue"), value: formatCurrency(data.summary.totalRetailValue) },
          { label: t("reports.potentialProfit"), value: formatCurrency(data.summary.totalPotentialProfit), tone: "positive" },
          { label: t("reports.lowStockItems"), value: String(data.summary.lowStockCount), tone: data.summary.lowStockCount > 0 ? "warning" : "positive" },
        ],
        meta: [
          { label: t("reports.totalProducts"), value: String(data.summary.totalProducts) },
          { label: t("reports.totalUnits"), value: String(data.summary.totalQuantity) },
          { label: t("reports.deadStockItems"), value: String(data.summary.deadStockCount), },
        ],
        sections: [
          {
            title: t("reports.categoryDetails"),
            columns: categoryExportColumns.map((c) => ({
              label: c.print?.label ?? c.header,
              align: c.print?.align,
              width: c.print?.width,
              strong: c.print?.strong,
              muted: c.print?.muted,
              value: (row: InventoryData["categoryBreakdown"][number]) => String(c.value(row) ?? ""),
              total: c.print?.total,
            })),
            rows: data.categoryBreakdown,
            totalsLabel: t("reports.stockValueCost"),
          },
          {
            title: t("reports.productTurnover"),
            columns: turnoverExportColumns.map((c) => ({
              label: c.print?.label ?? c.header,
              align: c.print?.align,
              width: c.print?.width,
              strong: c.print?.strong,
              muted: c.print?.muted,
              value: (row: InventoryData["turnoverData"][number]) => String(c.value(row) ?? ""),
              total: c.print?.total,
            })),
            rows: data.turnoverData.slice(0, 40),
            totalsLabel: t("reports.turnoverAnalysis"),
          },
          ...(data.agingProducts.length > 0
            ? [
                {
                  title: t("reports.agingTitle"),
                  columns: agingExportColumns.map((c) => ({
                    label: c.print?.label ?? c.header,
                    align: c.print?.align,
                    width: c.print?.width,
                    strong: c.print?.strong,
                    muted: c.print?.muted,
                    value: (row: InventoryData["agingProducts"][number]) => String(c.value(row) ?? ""),
                    total: c.print?.total,
                  })),
                  rows: data.agingProducts,
                  totalsLabel: t("reports.totalDeadStock"),
                },
              ]
            : []),
        ],
        footnote: t("reports.agingDesc"),
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("reports.inventoryReport")}
        description={t("reports.inventoryDesc")}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("nav.reportsLabel"), href: "/reports" },
          { label: t("nav.inventory") },
        ]}
        actions={
          <ExportMenu
            fileStem="inventory-report"
            sheetName="Inventory Report"
            rows={data?.categoryBreakdown ?? []}
            columns={categoryExportColumns}
            customItems={[
              { label: t("reports.exportCSV"), icon: "csv", onSelect: exportCSV },
              { label: t("export.excelSheets"), icon: "excel", onSelect: exportExcel },
            ]}
            printKicker="Stock Valuation & Turnover"
            printTotalsLabel={t("reports.stockValueCost")}
            onPrint={printInventoryReport}
            disabled={!data}
          />
        }
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-6"><div className="space-y-2"><div className="skeleton h-4 w-20 rounded" /><div className="skeleton h-8 w-28 rounded" /></div></CardContent></Card>
          ))}
        </div>
      ) : data ? (
        <>
          {/* Summary Stats */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={t("reports.stockValueCost")}
              value={formatCurrency(data.summary.totalCostValue)}
              numericValue={data.summary.totalCostValue}
              icon="box"
              tone="brand"
            />
            <StatCard
              label={t("reports.retailValue")}
              value={formatCurrency(data.summary.totalRetailValue)}
              numericValue={data.summary.totalRetailValue}
              icon="cash"
              tone="info"
            />
            <StatCard
              label={t("reports.potentialProfit")}
              value={formatCurrency(data.summary.totalPotentialProfit)}
              numericValue={data.summary.totalPotentialProfit}
              icon="trend"
              tone="success"
            />
            <StatCard
              label={t("reports.profitMargin")}
              value={`${data.summary.profitMargin}%`}
              numericValue={data.summary.profitMargin}
              formatValue={(v) => `${v.toFixed(1)}%`}
              icon="chart"
              tone="warning"
            />
          </div>

          {/* Quick Stats */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <TotalProductsCard value={data.summary.totalProducts} tone="brand" />
            <StatCard
              label={t("reports.totalUnits")}
              value={String(data.summary.totalQuantity)}
              numericValue={data.summary.totalQuantity}
              formatValue={(v) => String(Math.round(v))}
              icon="bag"
              tone="info"
            />
            <StatCard
              label={t("reports.lowStockItems")}
              value={String(data.summary.lowStockCount)}
              numericValue={data.summary.lowStockCount}
              formatValue={(v) => String(Math.round(v))}
              icon="alert"
              tone={data.summary.lowStockCount > 0 ? "warning" : "success"}
              sub={data.summary.outOfStockCount > 0 ? `${data.summary.outOfStockCount} ${t("alerts.outOfStock")}` : undefined}
            />
            <StatCard
              label={t("reports.deadStockItems")}
              value={String(data.summary.deadStockCount)}
              numericValue={data.summary.deadStockCount}
              formatValue={(v) => String(Math.round(v))}
              icon="alert"
              tone={data.summary.deadStockCount > 0 ? "danger" : "success"}
            />
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-neu-hairline">
            {([["overview", t("reports.categoryBreakdown")], ["turnover", t("reports.turnoverAnalysis")], ["aging", t("reports.agingAnalysis")]] as const).map(([tab, label]) => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={cn(
                "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
                activeTab === tab ? "border-neu-accent-line text-neu-accent-ink-strong" : "border-transparent text-neu-faint hover:text-neu-primary"
              )}>{label}</button>
            ))}
          </div>

          {/* Tab Content */}
          {activeTab === "overview" && (
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Category Chart */}
              <Card className="flex flex-col">
                <CardHeader><CardTitle>{t("reports.stockByCategory")}</CardTitle></CardHeader>
                <CardContent className="flex flex-col"><BarChart data={categoryChartData} height={250} color="var(--neu-accent-line)" fillHeight /></CardContent>
              </Card>

              {/* Category Table */}
              <Card>
                <CardHeader><CardTitle>{t("reports.categoryDetails")}</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-neu-hairline">
                          <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-neu-faint">{t("products.category")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.items")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.units")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.costValue")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.margin")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neu-hairline">
                        {data.categoryBreakdown.map((cat) => (
                          <tr key={cat.name} className="hover:bg-neu-sunken/50">
                            <td className="px-3 py-2 text-sm font-medium text-neu-primary">{cat.name}</td>
                            <td className="px-3 py-2 text-end text-sm text-neu-muted">{cat.items}</td>
                            <td className="px-3 py-2 text-end text-sm text-neu-muted">{cat.quantity}</td>
                            <td className="px-3 py-2 text-end text-sm font-semibold text-neu-primary">{formatCurrency(cat.costValue)}</td>
                            <td className="px-3 py-2 text-end text-sm text-neu-ink-green">{formatCurrency(cat.margin)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Warehouse Breakdown */}
              {data.warehouseBreakdown.length > 1 && (
                <Card className="lg:col-span-2">
                  <CardHeader><CardTitle>{t("reports.stockByWarehouse")}</CardTitle></CardHeader>
                  <CardContent>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {data.warehouseBreakdown.map((wh) => (
                        <div key={wh.code} className="rounded-lg border border-neu-hairline p-4">
                          <p className="font-medium text-neu-primary">{wh.name}</p>
                          <p className="text-xs text-neu-faint font-mono">{wh.code}</p>
                          <div className="mt-2 flex justify-between text-sm">
                            <span className="text-neu-faint">{wh.quantity} {t("reports.units")}</span>
                            <span className="font-semibold">{formatCurrency(wh.costValue)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {activeTab === "turnover" && (
            <div className="grid gap-6 lg:grid-cols-3">
              {/* Turnover Donut */}
              <Card>
                <CardHeader><CardTitle>{t("reports.turnoverDistribution")}</CardTitle></CardHeader>
                <CardContent className="flex justify-center">
                  <DonutChart data={turnoverDonutData} size={180} />
                </CardContent>
              </Card>

              {/* Turnover Table */}
              <Card className="lg:col-span-2">
                <CardHeader><CardTitle>{t("reports.productTurnover")}</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-neu-bg">
                        <tr className="border-b border-neu-hairline">
                          <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-neu-faint">{t("products.name")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("products.stock")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.sold30d")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.daysLeft")}</th>
                          <th className="px-3 py-2 text-center text-xs font-semibold uppercase text-neu-faint">{t("reports.turnoverCat")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neu-hairline">
                        {data.turnoverData.map((item) => (
                          <tr key={item.sku} className="hover:bg-neu-sunken/50">
                            <td className="px-3 py-2">
                              <p className="text-sm font-medium text-neu-primary">{item.productName}</p>
                              <p className="text-xs text-neu-faint font-mono">{item.sku}</p>
                            </td>
                            <td className="px-3 py-2 text-end text-sm text-neu-primary">{item.currentStock}</td>
                            <td className="px-3 py-2 text-end text-sm text-neu-primary">{item.soldLast30Days}</td>
                            <td className="px-3 py-2 text-end text-sm font-medium">
                              {item.daysOfStock >= 999 ? "∞" : item.daysOfStock}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <Badge variant={turnoverColorMap[item.turnoverCategory] ?? "default"} size="sm">
                                {turnoverLabel(item.turnoverCategory)}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "aging" && (
            <Card>
              <CardHeader>
                <CardTitle>{t("reports.agingTitle")}</CardTitle>
                <p className="text-sm text-neu-faint">{t("reports.agingDesc")}</p>
              </CardHeader>
              <CardContent>
                {data.agingProducts.length === 0 ? (
                  <EmptyState
                    bare
                    icon={
                      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    }
                    title={t("reports.noDeadStock")}
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-neu-hairline">
                          <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-neu-faint">{t("products.name")}</th>
                          <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-neu-faint">{t("products.category")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("products.stock")}</th>
                          <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-neu-faint">{t("reports.valueAtRisk")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neu-hairline">
                        {data.agingProducts.map((item) => (
                          <tr key={item.sku} className="hover:bg-neu-sunken/50">
                            <td className="px-3 py-2">
                              <p className="text-sm font-medium text-neu-primary">{item.productName}</p>
                              <p className="text-xs text-neu-faint font-mono">{item.sku}</p>
                            </td>
                            <td className="px-3 py-2 text-sm text-neu-muted">{item.category}</td>
                            <td className="px-3 py-2 text-end text-sm font-semibold text-neu-ink-red">{item.quantity}</td>
                            <td className="px-3 py-2 text-end text-sm font-semibold text-neu-primary">{formatCurrency(item.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-neu-hairline font-semibold">
                          <td colSpan={2} className="px-3 py-2 text-sm text-neu-primary">{t("reports.totalDeadStock")}</td>
                          <td className="px-3 py-2 text-end text-sm text-neu-ink-red">{data.agingProducts.reduce((s, i) => s + i.quantity, 0)}</td>
                          <td className="px-3 py-2 text-end text-sm text-neu-primary">{formatCurrency(data.agingProducts.reduce((s, i) => s + i.value, 0))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
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
