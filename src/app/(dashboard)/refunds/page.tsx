"use client";

import * as React from "react";
import { formatCurrency, formatDate, formatTime, cn } from "@/lib/utils";
import { downloadCsv } from "@/lib/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { fetchReportSettings, printReport } from "@/lib/print-report";
import { lineQtyLabel, trimNumber, WHOLE_UNITS } from "@/lib/units";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { SortableTh } from "@/components/ui/sortable-th";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { SmartImage } from "@/components/ui/smart-image";
import { BarChart, monthRange } from "@/components/ui/chart";
import { toast } from "@/stores/toast-store";
import { useResellFromOrder } from "@/hooks/use-resell-from-order";
import { printRefundReceiptsForOrders } from "@/lib/print-receipt";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* ═══════════════════════════════════════════════════════════════
   REFUNDS & RETURNS PAGE
   Focused ledger of every refunded order: who refunded, when,
   how much, and why — with unit-aware restored-item details.
   Refunds themselves are processed from the Orders screen, which
   restores stock atomically; this screen is the audit trail.
   ═══════════════════════════════════════════════════════════════ */

interface RefundItem {
  id: string;
  productId?: string; // present on the full detail fetch (used for re-sell)
  productName: string;
  sku: string;
  quantity: number;
  refundedQuantity?: number;
  unit?: string | null;
  unitPrice: number;
  total: number;
  product?: { id: string; name: string; imageUrl?: string } | null;
}

interface RefundPayment {
  id: string;
  method: string;
  amount: number;
  status: string;
}

interface RefundOrder {
  id: string;
  orderNumber: string;
  status: string;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  refundReason?: string | null;
  refundedAt?: string | null;
  refundedAmount?: number;
  createdAt: string;
  user: { id: string; name: string };
  refundedBy?: { id: string; name: string } | null;
  customer?: { id: string; name: string; email?: string; phone?: string } | null;
  items: RefundItem[];
  payments: RefundPayment[];
  itemCount: number;
  lineCount: number;
  fractional: boolean;
}

interface RefundsResponse {
  orders: RefundOrder[];
  total: number;
  sumTotal?: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

function perUnitSuffix(unit?: string | null): string {
  return unit && !WHOLE_UNITS.has(unit) ? ` / ${unit}` : "";
}

function reasonBadgeClass(): string {
  return "bg-neu-wash-amber text-neu-ink-amber border-neu-ink-amber/20";
}

/** Compact avatar initials for named customers (shared page style). */
function initials(name: string): string {
  return (
    name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/** Local YYYY-MM-DD (the API parses these at local midnight, so they must
 *  never be built from toISOString() — a UTC shift leaks adjacent days). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** Shared field styling for the date inputs — dark-mode safe. */
const dateFieldClass =
  "h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary neu-focus";

const PAGE_SIZE = 15;

export default function RefundsPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [orders, setOrders] = React.useState<RefundOrder[]>([]);
  const [total, setTotal] = React.useState(0);
  const [sumTotal, setSumTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(0);
  const [hasNext, setHasNext] = React.useState(false);

  // Date range (refund-processing dates) + scoped analytics
  interface RefundStats {
    total: number;
    sumTotal: number;
    average: number;
    monthlyTrend: Array<{ month: string; count: number; total: number }>;
    reasons: Array<{ reason: string | null; count: number; total: number }>;
  }
  const [stats, setStats] = React.useState<RefundStats | null>(null);
  const [statsLoading, setStatsLoading] = React.useState(true);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [activePreset, setActivePreset] = React.useState("all");

  // Reason drill-down: null = every refund; "__none__" = no reason recorded;
  // any other value matches that exact reason string.
  const NO_REASON = "__none__";
  const [reasonFilter, setReasonFilter] = React.useState<string | null>(null);
  const reasonLabel = React.useCallback(
    (reason: string | null) => (reason === NO_REASON || reason == null ? t("refunds.noReason") : reason),
    [t]
  );

  // Print the refunds currently in the ledger (current page) as receipts
  async function printReceipts() {
    if (orders.length === 0) return;
    setPrinting(true);
    try {
      await printRefundReceiptsForOrders(orders, t);
    } catch {
      toast.error(t("common.exportFailed"), t("common.exportFailedDesc"));
    } finally {
      setPrinting(false);
    }
  }

  const [printing, setPrinting] = React.useState(false);

  // Fetch every refund in the active range (the API caps a page at 100)
  const fetchAllRefunds = React.useCallback(async (): Promise<RefundOrder[]> => {
    const collected: RefundsResponse["orders"] = [];
    let cursor = 1;
    let data: RefundsResponse | undefined;
    do {
      const params = new URLSearchParams({ status: "refunded,partially_refunded", pageSize: "100", page: String(cursor) });
      if (search) params.set("search", search);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (reasonFilter) params.set("reason", reasonFilter);
      const res = await fetch(`/api/orders?${params}`);
      const d: RefundsResponse = await res.json();
      data = d;
      collected.push(...(d.orders ?? []));
      cursor += 1;
    } while (data && collected.length < (data.total ?? 0) && cursor <= 100);
    return collected;
  }, [search, dateFrom, dateTo, reasonFilter]);

  // Elite shared export columns — one config drives CSV, Excel and print.
  const refundExportColumns: ExportColumn<RefundOrder>[] = [
    { header: "orderNumber", value: (o) => o.orderNumber, print: { width: "12%" } },
    { header: "customer", value: (o) => o.customer?.name ?? t("orders.walkInCustomer") },
    { header: "refundedBy", value: (o) => o.refundedBy?.name ?? o.user?.name ?? "", print: { muted: true } },
    { header: "refundedOn", value: (o) => (o.refundedAt ? new Date(o.refundedAt).toISOString() : ""), print: { label: "Date", width: "13%" } },
    { header: "items", value: (o) => String(o.fractional ? (o.lineCount ?? o.items?.length ?? 0) : trimNumber(o.itemCount ?? o.items?.length ?? 0)), excelStyle: "int", print: { align: "right" } },
    {
      header: "refundedAmount",
      value: (o) => ((o.refundedAmount || (o.status === "refunded" ? o.total : 0)) / 100).toFixed(2),
      excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + (r.refundedAmount || (r.status === "refunded" ? r.total : 0)), 0)) },
    },
    { header: "reason", value: (o) => o.refundReason ?? "", print: { muted: true } },
  ];

  async function exportCSV() {
    try {
      const collected = await fetchAllRefunds();
      downloadCsv(
        "refunds",
        refundExportColumns.map((c) => c.header),
        collected.map((o) => refundExportColumns.map((c) => c.value(o)))
      );
      toast.success(t("common.exportStarted"), `${collected.length} ${t("orders.totalCount")}`);
    } catch {
      toast.error(t("common.exportFailed"), t("common.exportFailedDesc"));
    }
  }

  // Printed A4 refund ledger via the shared report engine
  const printRefundLedger = async () => {
    const collected = await fetchAllRefunds();
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("refunds.title"),
        kicker: "Refunds Ledger",
        periodLabel: [dateFrom, dateTo].filter(Boolean).join(" → ") || undefined,
        kpis: [
          { label: t("refunds.totalRefunds"), value: String(collected.length) },
          { label: t("refunds.totalRefunded"), value: formatCurrency(collected.reduce((s, o) => s + (o.refundedAmount || (o.status === "refunded" ? o.total : 0)), 0)), tone: "negative" },
          { label: t("refunds.averageRefund"), value: formatCurrency(collected.length ? Math.round(collected.reduce((s, o) => s + (o.refundedAmount || (o.status === "refunded" ? o.total : 0)), 0) / collected.length) : 0) },
        ],
        columns: refundExportColumns.map((c) => ({
          label: c.print?.label ?? c.header,
          align: c.print?.align,
          width: c.print?.width,
          strong: c.print?.strong,
          muted: c.print?.muted,
          value: (row: RefundOrder) => String(c.value(row) ?? ""),
          total: c.print?.total,
        })),
        rows: collected,
        totalsLabel: t("refunds.totalRefunded"),
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  // Detail modal
  const [detailOrder, setDetailOrder] = React.useState<RefundOrder | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const { resellFromOrder, reselling } = useResellFromOrder();

  // Monotonic request ids: a slower earlier response (e.g. the all-time
  // stats fired on mount) must never overwrite the scoped one that a
  // drill-down triggered — otherwise a month drill-down can flash the
  // store-wide totals. Only the latest request for each feed may commit.
  const ordersReq = React.useRef(0);
  const statsReq = React.useRef(0);

  // Fetch refunded orders (range applies to refund-processing dates)
  // Server-side sort in the shared "field.order" wire format — the /api/orders
  // allow-list covers the refund columns (refundedBy, refundedAt, reason).
  // Dates/money open high→low; text columns A→Z.
  const [sort, setSort] = React.useState("refundedAt.desc");
  function toggleSort(field: string) {
    setSort((s) => {
      if (s.startsWith(`${field}.`)) {
        return `${field}.${s.endsWith(".asc") ? "desc" : "asc"}`;
      }
      return `${field}.${field === "orderNumber" || field === "customer" || field === "refundedBy" || field === "refundReason" ? "asc" : "desc"}`;
    });
  }

  const fetchOrders = React.useCallback(async () => {
    const reqId = ++ordersReq.current;
    setLoading(true);
    setLoadError(false);
    const params = new URLSearchParams({ status: "refunded,partially_refunded", page: String(page), pageSize: "15" });
    if (search) params.set("search", search);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (reasonFilter) params.set("reason", reasonFilter);
    params.set("sort", sort);

    try {
      const res = await fetch(`/api/orders?${params}`);
      const data: RefundsResponse = await res.json();
      if (reqId !== ordersReq.current) return; // stale response — drop it
      setOrders(data.orders ?? []);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setHasNext(data.hasNext);
    } catch (e) {
      console.error(e);
      setLoadError(true);
    } finally {
      if (reqId === ordersReq.current) setLoading(false);
    }
  }, [page, search, dateFrom, dateTo, reasonFilter, sort]);

  // Scoped aggregates + monthly refund trend (full range, not just the page)
  const fetchStats = React.useCallback(async () => {
    const reqId = ++statsReq.current;
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    setStatsLoading(true);
    try {
      const res = await fetch(`/api/refunds?${params}`);
      const data: RefundStats = await res.json();
      if (reqId !== statsReq.current) return; // stale response — drop it
      if (data && typeof data.total === "number") {
        setStats(data);
        setSumTotal(data.sumTotal);
      }
    } catch (e) {
      console.error(e);
      // Stats stay degraded (page-level fallbacks render) — never a stuck skeleton.
    } finally {
      if (reqId === statsReq.current) setStatsLoading(false);
    }
  }, [dateFrom, dateTo]);

  // Honours drill-down links (e.g. clicking a month bar on the dashboard):
  // /refunds?from=YYYY-MM-DD&to=YYYY-MM-DD pre-selects that range.
  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const from = sp.get("from") ?? "";
    const to = sp.get("to") ?? "";
    const reason = sp.get("reason") ?? "";
    if (from || to) {
      setDateFrom(from);
      setDateTo(to);
      setActivePreset("custom");
    }
    if (reason) setReasonFilter(reason);
  }, []);

  React.useEffect(() => { fetchOrders(); }, [fetchOrders]);
  React.useEffect(() => { fetchStats(); }, [fetchStats]);
  React.useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, reasonFilter, sort]);

  // Debounced search
  const [searchInput, setSearchInput] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Date-range presets (all resolved in local time — see isoDay)
  function applyRange(preset: string, from = "", to = "") {
    setActivePreset(preset);
    setDateFrom(from);
    setDateTo(to);
  }
  function applyPreset(preset: string) {
    const now = new Date();
    if (preset === "month") {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      applyRange("month", isoDay(first), isoDay(now));
    } else if (preset === "30") {
      const from = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
      applyRange("30", isoDay(from), isoDay(now));
    } else if (preset === "90") {
      const from = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);
      applyRange("90", isoDay(from), isoDay(now));
    } else {
      applyRange("all");
    }
  }
  function presetClass(active: boolean): string {
    return active
      ? "rounded-lg bg-neu-accent-solid px-3 py-1.5 text-xs font-medium text-white transition-colors"
      : "rounded-lg bg-neu-sunken px-3 py-1.5 text-xs font-medium text-neu-muted transition-colors";
  }

  // View a full refund record
  async function viewDetail(order: RefundOrder) {
    setDetailLoading(true);
    setDetailOrder(order);
    try {
      const res = await fetch(`/api/orders/${order.id}`);
      const data = await res.json();
      setDetailOrder(data.order);
    } catch (e) {
      console.error(e);
    } finally {
      setDetailLoading(false);
    }
  }

  const refundCount = stats?.total ?? total;
  const avg = stats ? stats.average : refundCount > 0 ? Math.round(sumTotal / refundCount) : 0;

  // Chart-ready monthly buckets (refunded value per month)
  const monthLabel = (ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  };
  const trendData = (stats?.monthlyTrend ?? []).map((row) => ({
    label: monthLabel(row.month),
    value: row.total,
    count: row.count,
    month: row.month,
  }));

  const hasFilters = Boolean(search || dateFrom || dateTo || reasonFilter);

  function clearAllFilters() {
    setSearchInput("");
    setSearch("");
    setReasonFilter(null);
    applyPreset("all");
  }

  // Toggle the ledger reason drill-down (clicking the active reason clears it).
  function applyReason(reason: string | null) {
    const next = reason ?? NO_REASON;
    setReasonFilter((current) => (current === next ? null : next));
    document.getElementById("refunds-ledger")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Download the top-reason breakdown (scoped to the active date range) as CSV.
  function exportReasonsCsv() {
    const rows = stats?.reasons ?? [];
    if (rows.length === 0) return;
    const counted = rows.reduce((s, r) => s + r.count, 0);
    downloadCsv(
      "refund-reasons",
      [t("refunds.reason"), t("refunds.totalRefunds"), t("refunds.totalRefunded"), t("refunds.shareOfRefunds")],
      rows.map((r) => [
        reasonLabel(r.reason),
        r.count,
        (r.total / 100).toFixed(2),
        counted > 0 ? `${((r.count / counted) * 100).toFixed(1)}%` : "0.0%",
      ])
    );
    toast.success(t("common.exportStarted"), `${rows.length} · ${t("refunds.topReasons")}`);
  }

  // Shared empty state for table + mobile list
  const emptyStateNode = (
    <EmptyState
      bare
      icon={
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
        </svg>
      }
      title={hasFilters ? t("refunds.noMatch") : t("refunds.empty")}
      description={hasFilters ? t("common.noMatchHint") : t("refunds.emptyHint")}
      action={
        hasFilters ? (
          <Button variant="secondary" size="sm" onClick={clearAllFilters}>
            {t("common.clearFilters")}
          </Button>
        ) : undefined
      }
    />
  );

  const errorStateNode = (
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
        <Button variant="secondary" size="sm" onClick={fetchOrders}>
          {t("common.retry")}
        </Button>
      }
    />
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("refunds.title")}
        description={`${refundCount} ${t("orders.totalCount")}`}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("orders.title"), href: "/orders" },
          { label: t("refunds.title") },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={printReceipts}
              loading={printing}
              disabled={orders.length === 0}
              title={t("refunds.printPageHint")}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5z" />
              </svg>
              {t("refunds.print")}
            </Button>
            <ExportMenu<RefundOrder>
              fileStem="refunds"
              sheetName="Refunds"
              rows={orders}
              columns={refundExportColumns}
              customItems={[{ label: t("export.fetchAllThenCsv"), icon: "csv", onSelect: exportCSV }]}
              period={[dateFrom, dateTo].filter(Boolean).join(" → ") || undefined}
              printKpis={[
                { label: t("refunds.totalRefunds"), value: String(refundCount) },
                { label: t("refunds.totalRefunded"), value: formatCurrency(sumTotal), tone: "negative" },
                { label: t("refunds.averageRefund"), value: formatCurrency(avg) },
              ]}
              onPrint={printRefundLedger}
              disabled={refundCount === 0}
            />
          </div>
        }
      />

      {/* ─── KPI strip (scoped to the active date range) ─── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {loading || statsLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <div className="space-y-3">
                  <div className="skeleton h-10 w-10 rounded-xl" style={{ animationDelay: `${i * 60}ms` }} />
                  <div className="skeleton h-3.5 w-24 rounded" style={{ animationDelay: `${i * 60 + 30}ms` }} />
                  <div className="skeleton h-7 w-28 rounded" style={{ animationDelay: `${i * 60 + 60}ms` }} />
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <StatCard
              label={t("refunds.totalRefunds")}
              value={String(refundCount)}
              icon="bag"
              tone="danger"
            />
            <StatCard
              label={t("refunds.totalRefunded")}
              value={formatCurrency(sumTotal)}
              icon="cash"
              tone="warning"
            />
            <StatCard
              label={t("refunds.averageRefund")}
              value={formatCurrency(avg)}
              icon="chart"
              tone="info"
              sub={refundCount > 0 ? t("refunds.kpiRangeSub", { n: refundCount }) : undefined}
            />
          </>
        )}
      </div>

      {/* Top refund reasons */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>{t("refunds.topReasons")}</CardTitle>
              <p className="mt-1 text-sm text-neu-faint">{t("refunds.reasonsDesc")}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportReasonsCsv}
              disabled={(stats?.reasons?.length ?? 0) === 0}
              title={t("refunds.exportReasons")}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              {t("refunds.exportReasons")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {(stats?.reasons?.length ?? 0) === 0 ? (
            <p className="py-4 text-center text-sm text-neu-faint">{t("refunds.noReason")}</p>
          ) : (
            <div className="space-y-1">
              {stats!.reasons.map((row, i) => {
                const pct = refundCount > 0 ? (row.count / refundCount) * 100 : 0;
                const key = row.reason ?? NO_REASON;
                const active = reasonFilter === key;
                return (
                  <button
                    key={row.reason ?? `none-${i}`}
                    type="button"
                    onClick={() => applyReason(row.reason)}
                    title={`${t("refunds.filterByReason")}: ${reasonLabel(row.reason)}`}
                    aria-pressed={active}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-start transition-colors",
                      active
                        ? "bg-neu-wash-amber"
                        : "hover:bg-neu-sunken"
                    )}
                  >
                    <span
                      className={cn(
                        "w-1 shrink-0 self-stretch rounded-full transition-colors",
                        active ? "bg-neu-solid-red" : "bg-neu-solid-red/70 group-hover:bg-neu-solid-red"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p
                          className={cn(
                            "truncate text-sm",
                            active ? "font-semibold text-neu-ink-amber" : "font-medium text-neu-primary"
                          )}
                          title={reasonLabel(row.reason)}
                        >
                          {row.reason ?? <span className="italic text-neu-faint">{t("refunds.noReason")}</span>}
                        </p>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-neu-primary">
                          {row.count} · {formatCurrency(row.total)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neu-sunken">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            active ? "bg-neu-ink-amber" : "bg-neu-ink-red"
                          )}
                          style={{ width: `${Math.max(pct, 2)}%` }}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Monthly refund trend */}
      <Card>
        <CardHeader>
          <CardTitle>{t("refunds.monthlyTrend")}</CardTitle>
          <p className="text-sm text-neu-faint">{t("refunds.trendDesc")}</p>
        </CardHeader>
        <CardContent>
          <BarChart
            data={trendData}
            height={220}
            color="var(--neu-ink-red)"
            onBarClick={(d) => {
              // Clicking a month bar filters the ledger (KPIs + table) to it
              const range = monthRange(String(d["month"] ?? ""));
              if (range) {
                applyRange("custom", range.from, range.to);
                document.getElementById("refunds-ledger")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }
            }}
          />
        </CardContent>
      </Card>

      {/* Filters: search + refund-date range */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              placeholder={t("refunds.searchPlaceholder")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              leftIcon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
              wrapperClassName="w-full sm:w-80"
            />
            <Badge variant="danger" size="sm" className="gap-1">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
              </svg>
              {t("orders.refunded")}
            </Badge>
            {hasFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-xs font-medium text-neu-accent-ink transition-colors hover:text-neu-accent-ink-strong"
              >
                {t("common.clearFilters")}
              </button>
            )}
          </div>
          {/* Active reason drill-down */}
          {reasonFilter && (
            <div className="flex flex-wrap items-center gap-2 border-t border-neu-hairline pt-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-neu-faint">
                {t("refunds.reasonFilterActive")}
              </span>
              <Badge variant="warning" size="sm" className="max-w-[min(22rem,70vw)] gap-1">
                <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
                </svg>
                <span className="truncate" title={reasonLabel(reasonFilter)}>{reasonLabel(reasonFilter)}</span>
              </Badge>
              <button
                type="button"
                onClick={() => setReasonFilter(null)}
                className="text-xs font-medium text-neu-accent-ink transition-colors hover:text-neu-accent-ink-strong"
              >
                {t("refunds.clearReason")}
              </button>
            </div>
          )}
          {/* Date range */}
          <div className="flex flex-wrap items-center gap-2.5 border-t border-neu-hairline pt-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-neu-faint">
              {t("refunds.dateRange")}
            </span>
            {[
              { key: "all", label: t("refunds.allTime") },
              { key: "month", label: t("refunds.thisMonth") },
              { key: "30", label: t("refunds.last30") },
              { key: "90", label: t("refunds.last90") },
            ].map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key)}
                className={presetClass(activePreset === p.key)}
              >
                {p.label}
              </button>
            ))}
            <span className="mx-1 hidden h-4 w-px bg-neu-sunken sm:block" />
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setActivePreset("custom");
              }}
              aria-label={t("refunds.dateRange")}
              className={dateFieldClass}
            />
            <span className="text-sm text-neu-faint">{t("reports.to")}</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                setDateTo(e.target.value);
                setActivePreset("custom");
              }}
              aria-label={t("refunds.dateRange")}
              className={dateFieldClass}
            />
          </div>
        </CardContent>
      </Card>

      {/* ─── Refunds ledger ─── */}
      <Card id="refunds-ledger">
        {/* Mobile: stacked refund cards */}
        <div className="divide-y divide-neu-hairline md:hidden">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-20 rounded-xl" style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          ) : loadError ? (
            errorStateNode
          ) : orders.length === 0 ? (
            emptyStateNode
          ) : (
            orders.map((order) => (
              <div
                key={order.id}
                className="cursor-pointer px-4 py-3.5 transition-colors hover:bg-neu-sunken/60"
                onClick={() => viewDetail(order)}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-[13px] font-semibold text-neu-primary">{order.orderNumber}</span>
                      {order.status === "partially_refunded" && (
                        <Badge variant="warning" size="sm">{t("orders.partiallyRefunded")}</Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-neu-muted">
                      {order.customer?.name ?? t("orders.walkIn")} · {order.refundedBy?.name ?? order.user.name}
                    </p>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); applyReason(order.refundReason ?? null); }}
                      title={t("refunds.filterByReason")}
                      className={cn(
                        "mt-0.5 block w-fit max-w-full truncate rounded-md px-1.5 py-0.5 text-xs italic transition-colors",
                        reasonFilter === (order.refundReason ?? NO_REASON)
                          ? "bg-neu-wash-amber font-medium text-neu-ink-amber"
                          : "text-neu-faint hover:bg-neu-sunken hover:text-neu-muted"
                      )}
                    >
                      {order.refundReason ?? t("refunds.noReason")}
                    </button>
                    <p className="mt-0.5 text-xs tabular-nums text-neu-faint">
                      {order.refundedAt ? `${formatDate(order.refundedAt, "medium")} · ${formatTime(order.refundedAt)}` : "—"}
                    </p>
                  </div>
                  <div className="shrink-0 text-end">
                    <p className="text-sm font-bold tabular-nums text-neu-ink-red">
                      −{formatCurrency(order.refundedAmount || (order.status === "refunded" ? order.total : 0))}
                    </p>
                    <p className="text-[11px] tabular-nums text-neu-faint">
                      {order.fractional ? order.lineCount : trimNumber(order.itemCount)} {t("orders.items")}
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Desktop: full ledger table (progressively hides low-priority columns) */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neu-hairline bg-neu-sunken">
                <SortableTh label={t("orders.orderNumber")} active={sort.startsWith("orderNumber.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("orderNumber")} />
                <SortableTh label={t("orders.customer")} active={sort.startsWith("customer.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("customer")} />
                <SortableTh label={t("refunds.refundedBy")} className="hidden lg:table-cell" active={sort.startsWith("refundedBy.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("refundedBy")} />
                <th className="hidden whitespace-nowrap px-4 py-3 text-end text-xs font-semibold uppercase tracking-wider text-neu-faint xl:table-cell">{t("orders.items")}</th>
                <SortableTh label={t("refunds.refundedAmount")} align="end" active={sort.startsWith("total.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("total")} />
                <SortableTh label={t("refunds.reason")} className="hidden lg:table-cell" active={sort.startsWith("refundReason.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("refundReason")} />
                <SortableTh label={t("refunds.refundedOn")} active={sort.startsWith("refundedAt.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("refundedAt")} />
                <th className="whitespace-nowrap px-4 py-3 text-end text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("orders.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neu-hairline">
              {loading ? (
                <TableSkeleton rows={8} />
              ) : loadError ? (
                <tr>
                  <td colSpan={8} className="px-4 py-0">
                    {errorStateNode}
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-0">
                    {emptyStateNode}
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.id} className="cursor-pointer hover:bg-neu-sunken/50" onClick={() => viewDetail(order)}>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="font-mono text-[13px] font-medium text-neu-primary">{order.orderNumber}</span>
                    </td>
                    <td className="max-w-[180px] px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {order.customer ? (
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neu-accent-wash text-[10px] font-bold text-neu-accent-ink-strong">
                            {initials(order.customer.name)}
                          </span>
                        ) : (
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neu-sunken text-neu-faint">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                            </svg>
                          </span>
                        )}
                        <span className="truncate text-sm text-neu-primary">
                          {order.customer?.name ?? t("orders.walkIn")}
                        </span>
                      </div>
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-sm text-neu-muted lg:table-cell">{order.refundedBy?.name ?? order.user.name}</td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-end text-sm tabular-nums text-neu-primary xl:table-cell">
                      {order.fractional ? order.lineCount : trimNumber(order.itemCount)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end text-sm font-semibold tabular-nums text-neu-ink-red">
                      −{formatCurrency(order.refundedAmount || (order.status === "refunded" ? order.total : 0))}
                    </td>
                    <td className="hidden max-w-[220px] px-4 py-3 lg:table-cell">
                      {order.refundReason ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); applyReason(order.refundReason!); }}
                          title={t("refunds.filterByReason")}
                          className={cn(
                            "block max-w-full truncate rounded-md px-1.5 py-0.5 text-start text-sm transition-colors",
                            reasonFilter === order.refundReason
                              ? "bg-neu-wash-amber font-medium text-neu-ink-amber"
                              : "text-neu-muted hover:bg-neu-wash-amber hover:text-neu-ink-amber"
                          )}
                        >
                          {order.refundReason}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); applyReason(null); }}
                          title={t("refunds.filterByReason")}
                          className={cn(
                            "rounded-md px-1.5 py-0.5 text-sm italic transition-colors",
                            reasonFilter === NO_REASON
                              ? "bg-neu-sunken font-medium text-neu-primary"
                              : "text-neu-faint hover:bg-neu-sunken hover:text-neu-muted"
                          )}
                        >
                          {t("refunds.noReason")}
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <p className="text-xs font-medium text-neu-muted">
                        {order.refundedAt ? formatDate(order.refundedAt, "medium") : "—"}
                      </p>
                      {order.refundedAt && (
                        <p className="text-[11px] tabular-nums text-neu-faint">{formatTime(order.refundedAt)}</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-2">
                        {order.status === "partially_refunded" && (
                          <Badge variant="warning" size="sm">{t("orders.partiallyRefunded")}</Badge>
                        )}
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); viewDetail(order); }}>
                          {t("orders.viewDetails")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-col items-center justify-between gap-3 border-t border-neu-hairline px-4 py-3 sm:flex-row">
            <p className="text-center text-xs tabular-nums text-neu-faint sm:text-start sm:text-sm">
              {t("orders.showing", {
                from: (page - 1) * PAGE_SIZE + 1,
                to: Math.min(page * PAGE_SIZE, total),
                total,
              })}
            </p>
            <div className="flex gap-1">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("common.previous")}</Button>
              <Button variant="secondary" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>{t("common.next")}</Button>
            </div>
          </div>
        )}
      </Card>

      {/* ═══ REFUND DETAIL MODAL ═══ */}
      <Dialog open={Boolean(detailOrder)} onOpenChange={(o) => !o && setDetailOrder(null)}>
        <DialogContent size="lg" height="tall">
          <DialogHeader>
            {detailOrder && !detailLoading ? (
              <div className="flex items-center justify-between w-full">
                <div>
                  <DialogTitle>{t("orders.orderNumber")} {detailOrder.orderNumber}</DialogTitle>
                  <p className="text-sm text-neu-faint mt-1">
                    {detailOrder.refundedAt ? formatDate(detailOrder.refundedAt, "full") : formatDate(detailOrder.createdAt, "full")}
                  </p>
                </div>
                {detailOrder.status === "partially_refunded" ? (
                  <Badge variant="warning" size="lg" className="gap-1">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                    </svg>
                    {t("orders.partiallyRefunded")}
                  </Badge>
                ) : (
                  <Badge variant="danger" size="lg" className="gap-1">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                    </svg>
                    {t("orders.refunded")}
                  </Badge>
                )}
              </div>
            ) : (
              <div className="flex w-full items-center justify-between gap-3">
                <div className="skeleton h-7 w-48" />
                <div className="skeleton h-6 w-28 rounded-full" />
              </div>
            )}
          </DialogHeader>

          <DialogBody className="space-y-4">
            {detailLoading ? (
              <div className="space-y-4">
                <div className="skeleton h-16 w-full rounded-lg" />
                <div className="grid grid-cols-3 gap-3">
                  <div className="skeleton h-12 w-full rounded-lg" />
                  <div className="skeleton h-12 w-full rounded-lg" />
                  <div className="skeleton h-12 w-full rounded-lg" />
                </div>
                <div className="skeleton h-40 w-full rounded-lg" />
                <div className="skeleton h-24 w-full rounded-lg" />
              </div>
            ) : detailOrder ? (
              <>
                {/* Refund reason banner */}
                <div className={cn("flex items-start gap-2.5 rounded-lg border bg-neu-wash-amber p-3 text-sm", reasonBadgeClass())}>
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-neu-ink-amber" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-neu-ink-amber">{t("refunds.reason")}</p>
                    <p className="text-neu-ink-amber">{detailOrder.refundReason || t("refunds.noReason")}</p>
                  </div>
                </div>

                {/* People */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-neu-hairline bg-neu-sunken/60 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-neu-faint">{t("orders.customer")}</p>
                    <p className="mt-0.5 truncate text-sm font-medium text-neu-primary">
                      {detailOrder.customer?.name ?? t("orders.walkInCustomer")}
                    </p>
                    {(detailOrder.customer?.phone || detailOrder.customer?.email) && (
                      <p className="mt-0.5 truncate text-xs text-neu-faint">
                        {[detailOrder.customer?.phone, detailOrder.customer?.email].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="rounded-lg border border-neu-hairline bg-neu-sunken/60 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-neu-faint">{t("orders.cashier")}</p>
                    <p className="mt-0.5 truncate text-sm font-medium text-neu-primary">{detailOrder.user.name}</p>
                  </div>
                  <div className="rounded-lg border border-neu-hairline bg-neu-sunken/60 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-neu-faint">{t("refunds.refundedBy")}</p>
                    <p className="mt-0.5 truncate text-sm font-medium text-neu-primary">{detailOrder.refundedBy?.name ?? "—"}</p>
                    <p className="mt-0.5 truncate text-xs text-neu-faint">
                      {detailOrder.refundedAt
                        ? `${formatDate(detailOrder.refundedAt, "medium")} · ${formatTime(detailOrder.refundedAt)}`
                        : "—"}
                    </p>
                  </div>
                </div>

                {/* Returned items */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-neu-faint">{t("orders.items")}</p>
                    <span className="text-xs tabular-nums text-neu-faint">
                      {t("orders.itemsCount", { n: detailOrder.items.length })}
                    </span>
                  </div>
                  <div className="divide-y divide-neu-hairline rounded-lg border border-neu-hairline">
                    {detailOrder.items.map((item) => {
                      const refunded = item.refundedQuantity ?? 0;
                      const partial = refunded > 0 && refunded < item.quantity - 1e-9;
                      return (
                        <div key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                          <SmartImage
                            src={item.product?.imageUrl}
                            alt={item.productName}
                            className="h-9 w-9 shrink-0 rounded-lg"
                            iconClassName="h-4 w-4"
                            zoomOnHover={false}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-neu-primary">{item.productName}</p>
                            <p className="text-xs tabular-nums text-neu-faint">
                              {formatCurrency(item.unitPrice)}
                              <span className="text-neu-faint">{perUnitSuffix(item.unit)}</span>
                              {" × "}
                              {lineQtyLabel(item.quantity, item.unit)}
                              {refunded > 0 && (
                                <span className={partial ? "text-neu-ink-amber" : "text-neu-ink-green"}>
                                  {" · "}{t("orders.refundedQty")}: {lineQtyLabel(refunded, item.unit)}
                                </span>
                              )}
                            </p>
                          </div>
                          <span className="shrink-0 text-sm font-semibold tabular-nums text-neu-primary">{formatCurrency(item.total)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Totals */}
                <div className="space-y-2 rounded-lg bg-neu-sunken p-4">
                  <div className="flex justify-between text-sm text-neu-muted">
                    <span>{t("orders.subtotal")}</span>
                    <span className="tabular-nums">{formatCurrency(detailOrder.subtotal)}</span>
                  </div>
                  {detailOrder.taxAmount > 0 && (
                    <div className="flex justify-between text-sm text-neu-muted">
                      <span>{t("orders.tax")}</span>
                      <span className="tabular-nums">{formatCurrency(detailOrder.taxAmount)}</span>
                    </div>
                  )}
                  {detailOrder.discountAmount > 0 && (
                    <div className="flex justify-between text-sm text-neu-ink-green">
                      <span>{t("orders.discount")}</span>
                      <span className="tabular-nums">-{formatCurrency(detailOrder.discountAmount)}</span>
                    </div>
                  )}
                  <div className="flex border-t border-neu-hairline pt-2 text-lg font-bold text-neu-ink-red">
                    <span>{t("refunds.refundedAmount")}</span>
                    <span className="ms-auto tabular-nums">−{formatCurrency(detailOrder.refundedAmount || (detailOrder.status === "refunded" ? detailOrder.total : 0))}</span>
                  </div>
                </div>

                {/* Payment info */}
                <div>
                  <p className="text-xs font-medium text-neu-faint uppercase mb-2">{t("orders.payment")}</p>
                  <div className="flex gap-2 flex-wrap">
                    {detailOrder.payments.map((p) => (
                      <Badge key={p.id} variant={p.status === "refunded" ? "danger" : "success"} size="sm">
                        {t(`orders.paymentMethod.${p.method}`)}: {formatCurrency(Math.abs(p.amount))}
                        {p.status === "refunded" ? ` (${t("orders.refunded")})` : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </DialogBody>

          <DialogFooter className="flex-wrap dark:bg-neu-sunken/40">
            {detailOrder && !detailLoading && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => printRefundReceiptsForOrders([detailOrder], t)}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5z" />
                    </svg>
                    {t("refunds.printReceipt")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={reselling}
                    onClick={() => resellFromOrder(detailOrder)}
                    title={t("refunds.resellHint")}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                    </svg>
                    {t("refunds.resell")}
                  </Button>
                </div>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => setDetailOrder(null)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
