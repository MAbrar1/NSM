"use client";

import * as React from "react";
import { formatCurrency, formatDate, formatTime, cn } from "@/lib/utils";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { printReport, fetchReportSettings } from "@/lib/print-report";
import { lineQtyLabel, trimNumber, WHOLE_UNITS } from "@/lib/units";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { SmartImage } from "@/components/ui/smart-image";
import { toast } from "@/stores/toast-store";
import { useResellFromOrder } from "@/hooks/use-resell-from-order";
import { printRefundReceiptsForOrders } from "@/lib/print-receipt";
import { printPOSReceipt, POSReceiptOrder, POSReceiptSettings } from "@/lib/print-pos-receipt";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogBody,
  DialogTitle,
} from "@/components/ui/dialog";

/* ═══════════════════════════════════════════════════════════════
   ORDERS PAGE
   Full order management with KPI stat cards, search, status /
   payment / date-range filters, a responsive table (stacked cards
   on mobile), detail view, status updates, and refund processing.
   ═══════════════════════════════════════════════════════════════ */

interface OrderItem {
  id: string;
  productId?: string;
  productName: string;
  sku: string;
  quantity: number;
  refundedQuantity?: number;
  unit?: string | null;
  unitPrice: number;
  total: number;
  product?: { id: string; name: string; imageUrl?: string } | null;
}

interface OrderPayment {
  id: string;
  method: string;
  amount: number;
  status: string;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  type: string;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  paidAmount: number;
  /** Cents still owed on a credit (khata) sale. */
  dueAmount?: number;
  /** paid | partial | unpaid — how the bill was settled. */
  paymentStatus?: string;
  changeAmount: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string };
  refundedBy?: { id: string; name: string } | null;
  refundReason?: string | null;
  refundedAt?: string | null;
  refundedAmount?: number;
  customer?: { id: string; name: string; email?: string; phone?: string } | null;
  items: OrderItem[];
  payments: OrderPayment[];
  itemCount: number;
  lineCount: number;
  fractional: boolean;
}

/** "Items" cell: integer orders show the summed quantity, mixed-unit
 *  (kg/g/L) orders show the line count since adding 2 pcs + 0.385 kg
 *  into one number would be misleading. */
function itemsLabel(order: Order): string {
  if (order.fractional) return String(order.lineCount);
  return trimNumber(order.itemCount);
}

function perUnitSuffix(unit?: string | null): string {
  return unit && !WHOLE_UNITS.has(unit) ? ` / ${unit}` : "";
}

/** Compact avatar initials for named customers (Customers-page style). */
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

interface OrdersResponse {
  orders: Order[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

const PAGE_SIZE = 15;

/** Shared field styling for the native selects/date inputs. The tokens
 *  carry both modes, so there is no `dark:` override here. */
const selectFieldClass =
  "h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary neu-focus";

const statusColors: Record<string, "success" | "warning" | "danger" | "info" | "default"> = {
  completed: "success",
  confirmed: "info",
  processing: "warning",
  pending: "warning",
  cancelled: "danger",
  refunded: "danger",
  partially_refunded: "warning",
};

/** Local YYYY-MM-DD for the date-range inputs (the API parses these at
 *  local midnight, so never build them from toISOString()). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export default function OrdersPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [orders, setOrders] = React.useState<Order[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  // Credit (khata) filter: "" | "withDue" | "paid"
  const [paymentFilter, setPaymentFilter] = React.useState("");
  // Date range: "" means unbounded; values are local YYYY-MM-DD.
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [datePreset, setDatePreset] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [hasNext, setHasNext] = React.useState(false);

  function applyDatePreset(key: string) {
    setDatePreset(key);
    if (key === "all") {
      setDateFrom("");
      setDateTo("");
      return;
    }
    const now = new Date();
    if (key === "today") {
      const day = isoDay(now);
      setDateFrom(day);
      setDateTo(day);
      return;
    }
    // Rolling window ending today ("7" → last 7 days incl. today, etc.)
    const days = key === "7" ? 6 : 29;
    setDateFrom(isoDay(new Date(now.getTime() - days * 24 * 60 * 60 * 1000)));
    setDateTo(isoDay(now));
  }

  // Export dataset (all rows, not just the current page). Kept fresh on
  // every filter change so the KPI cards, export KPIs and the printed
  // ledger never show a previous filter's numbers.
  const [allOrders, setAllOrders] = React.useState<Order[]>([]);
  const [allLoading, setAllLoading] = React.useState(true);
  const exportSeq = React.useRef(0);
  const fetchAllOrders = React.useCallback(async () => {
    const seq = ++exportSeq.current;
    setAllLoading(true);
    const collected: OrdersResponse["orders"] = [];
    let cursor = 1;
    let data: OrdersResponse | undefined;
    try {
      do {
        const params = new URLSearchParams({ page: String(cursor), pageSize: "100" });
        if (search) params.set("search", search);
        if (statusFilter) params.set("status", statusFilter);
        if (paymentFilter) params.set("paymentStatus", paymentFilter);
        if (dateFrom) params.set("dateFrom", dateFrom);
        if (dateTo) params.set("dateTo", dateTo);
        const res = await fetch(`/api/orders?${params}`);
        const d: OrdersResponse = await res.json();
        data = d;
        collected.push(...(d.orders ?? []));
        cursor += 1;
      } while (data && collected.length < (data.total ?? 0) && cursor <= 100);
      if (seq === exportSeq.current) setAllOrders(collected);
    } catch {
      /* export dataset is best-effort */
    } finally {
      if (seq === exportSeq.current) setAllLoading(false);
    }
    return collected;
  }, [search, statusFilter, paymentFilter, dateFrom, dateTo]);

  React.useEffect(() => {
    void fetchAllOrders();
  }, [fetchAllOrders]);

  // Bulk selection (only non-refunded, non-cancelled orders are selectable)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const selectableOrders = React.useMemo(
    // Bulk refunds are full refunds; partially refunded orders need the
    // per-item dialog instead, so they are excluded from bulk selection.
    () =>
      orders.filter(
        (o) => o.status !== "refunded" && o.status !== "cancelled" && o.status !== "partially_refunded"
      ),
    [orders]
  );
  const allPageSelected = selectableOrders.length > 0 && selectableOrders.every((o) => selectedIds.has(o.id));

  function toggleSelect(orderId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        selectableOrders.forEach((o) => next.delete(o.id));
      } else {
        selectableOrders.forEach((o) => next.add(o.id));
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const selectedOrders = orders.filter((o) => selectedIds.has(o.id));
  const selectedTotal = selectedOrders.reduce((s, o) => s + o.total, 0);

  // Bulk refund modal
  const [bulkRefundOpen, setBulkRefundOpen] = React.useState(false);
  const [bulkCategory, setBulkCategory] = React.useState("");
  const [bulkDetail, setBulkDetail] = React.useState("");
  const [bulkRefunding, setBulkRefunding] = React.useState(false);

  async function handleBulkRefund() {
    if (selectedIds.size === 0) return;
    setBulkRefunding(true);
    try {
      const preset = bulkCategory ? refundPresets.find((p) => p.id === bulkCategory) : undefined;
      const detail = bulkDetail.trim();
      let reason = "";
      if (bulkCategory === "custom") {
        reason = detail;
      } else if (preset) {
        reason = detail ? `${preset.label} - ${detail}` : preset.label;
      }

      const res = await fetch("/api/orders/bulk-refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: [...selectedIds],
          reason: reason || undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(t("orders.refundFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }

      setBulkRefundOpen(false);
      setBulkCategory("");
      setBulkDetail("");
      clearSelection();
      fetchOrders();
      const refundedCount = data.refunded?.length ?? 0;
      const skippedCount = data.errors?.length ?? 0;
      if (refundedCount > 0) {
        toast.success(
          t("orders.bulkRefundProcessed"),
          `${refundedCount} ${t("orders.totalCount")}${skippedCount > 0 ? ` · ${skippedCount} ${t("orders.bulkRefundSkipped")}` : ""}`
        );
      } else if (skippedCount > 0) {
        toast.error(t("orders.refundFailed"), t("orders.bulkRefundAllSkipped"));
      }
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setBulkRefunding(false);
    }
  }

  // Elite shared export columns — one config drives CSV, Excel and the
  // printed A4 ledger (money cells styled, totals row in print).
  const orderExportColumns: ExportColumn<Order>[] = [
    { header: "orderNumber", value: (o) => o.orderNumber, print: { width: "11%" } },
    { header: "customer", value: (o) => o.customer?.name ?? t("orders.walkInCustomer") },
    { header: "cashier", value: (o) => o.user?.name ?? "", print: { muted: true } },
    { header: "date", value: (o) => new Date(o.createdAt).toISOString(), print: { label: "Date", width: "13%" } },
    { header: "items", value: (o) => String(o.fractional ? (o.lineCount ?? o.items?.length ?? 0) : (o.itemCount ?? o.items?.length ?? 0)), excelStyle: "int", print: { align: "right" } },
    { header: "subtotal", value: (o) => (o.subtotal / 100).toFixed(2), excelStyle: "money", print: { align: "right", muted: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.subtotal, 0)) } },
    { header: "discount", value: (o) => (o.discountAmount / 100).toFixed(2), excelStyle: "money", print: { align: "right", muted: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.discountAmount, 0)) } },
    { header: "tax", value: (o) => (o.taxAmount / 100).toFixed(2), excelStyle: "money", print: { align: "right", muted: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.taxAmount, 0)) } },
    {
      header: "total",
      value: (o) => (o.total / 100).toFixed(2),
      excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.total, 0)) },
    },
    {
      header: "paid",
      value: (o) => ((o.paidAmount ?? 0) / 100).toFixed(2),
      excelStyle: "money",
      print: { align: "right", total: (rows) => formatCurrency(rows.reduce((s, r) => s + (r.paidAmount ?? 0), 0)) },
    },
    {
      header: "due",
      value: (o) => ((o.dueAmount ?? 0) / 100).toFixed(2),
      excelStyle: "money",
      print: { align: "right", total: (rows) => formatCurrency(rows.reduce((s, r) => s + (r.dueAmount ?? 0), 0)) },
    },
    { header: "paymentStatus", value: (o) => o.paymentStatus ?? "paid", omitPrint: true },
    { header: "status", value: (o) => o.status, print: { align: "center" } },
  ];

  // A4 ledger print via the shared report engine
  const printLedger = async () => {
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("orders.title"),
        kicker: "Orders Ledger",
        meta: [
          { label: t("orders.total"), value: formatCurrency(allOrders.reduce((s, o) => s + o.total, 0)) },
          { label: t("orders.dueBadge"), value: formatCurrency(allOrders.reduce((s, o) => s + (o.dueAmount ?? 0), 0)) },
        ],
        columns: orderExportColumns.map((c) => ({
          label: c.print?.label ?? c.header,
          align: c.print?.align,
          width: c.print?.width,
          strong: c.print?.strong,
          muted: c.print?.muted,
          value: (row: Order) => String(c.value(row) ?? ""),
          total: c.print?.total,
        })),
        rows: allOrders,
        totalsLabel: t("orders.total"),
      },
      settings,
      { rtl: dir === "rtl" }
    );
  };

  // Detail modal
  const [detailOrder, setDetailOrder] = React.useState<Order | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  // Refund modal
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [refundCategory, setRefundCategory] = React.useState("");
  const [refundReason, setRefundReason] = React.useState("");
  const [refunding, setRefunding] = React.useState(false);
  // Per-item refund quantities (base units) — drives partial refunds
  const [refundQty, setRefundQty] = React.useState<Record<string, string>>({});

  // Remaining refundable quantity of a line (quantity − already refunded)
  function lineRemaining(item: OrderItem): number {
    return Math.max(0, item.quantity - (item.refundedQuantity ?? 0));
  }

  // Open the refund dialog prefilled to refund everything remaining.
  // A partially refunded order reopens with only the outstanding lines.
  function openRefundDialog(order: Order) {
    setRefundQty(
      Object.fromEntries(
        order.items
          .filter((it) => lineRemaining(it) > 0)
          .map((it) => [it.id, String(lineRemaining(it))])
      )
    );
    setRefundCategory("");
    setRefundReason("");
    setRefundOpen(true);
  }

  // Selected refund lines: id → quantity (skips zeroed lines)
  const selectedRefundLines = React.useMemo(() => {
    if (!detailOrder) return [];
    return detailOrder.items
      .map((it) => {
        const qty = parseFloat(refundQty[it.id] ?? "") || 0;
        return { item: it, qty: Math.min(qty, lineRemaining(it)) };
      })
      .filter((l) => l.qty > 0);
  }, [detailOrder, refundQty]);

  // Refunded value preview for the selected lines (proportional to line total)
  const refundPreview = React.useMemo(() => {
    return selectedRefundLines.reduce(
      (s, l) => s + Math.round((l.item.total * l.qty) / l.item.quantity),
      0
    );
  }, [selectedRefundLines]);

  // Custom refund-reason presets (admin-defined in Settings). When none are
  // stored the dialog falls back to the built-in localized presets.
  const [storedPresets, setStoredPresets] = React.useState<string[]>([]);
  React.useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const raw = d.settings?.refundReasonPresets;
        if (typeof raw !== "string" || !raw) return;
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            setStoredPresets(
              arr
                .filter((s) => typeof s === "string" && s.trim() && s.trim() !== "custom")
                .map((s) => s.trim())
                .slice(0, 12)
            );
          }
        } catch { /* ignore malformed stored value */ }
      })
      .catch(() => {});
  }, []);

  // Re-sell a refunded order straight from the register history
  const { resellFromOrder, reselling } = useResellFromOrder();

  // Fetch orders
  const fetchOrders = React.useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    if (paymentFilter) params.set("paymentStatus", paymentFilter);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);

    setLoadError(false);
    try {
      const res = await fetch(`/api/orders?${params}`);
      const data: OrdersResponse = await res.json();
      setOrders(data.orders ?? []);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setHasNext(data.hasNext);
    } catch (e) {
      console.error(e);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, paymentFilter, dateFrom, dateTo]);

  React.useEffect(() => { fetchOrders(); }, [fetchOrders]);
  React.useEffect(() => { setPage(1); }, [search, statusFilter, paymentFilter, dateFrom, dateTo]);
  React.useEffect(() => { clearSelection(); }, [page, search, statusFilter, paymentFilter, dateFrom, dateTo]);

  // Debounced search
  const [searchInput, setSearchInput] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // View order detail
  async function viewDetail(order: Order) {
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

  // Process refund. A preset category may be combined with optional free
  // text detail ("Customer returned item - packing was damaged") so the
  // stored reason stays readable in the Refunds ledger & breakdown.
  async function handleRefund() {
    if (!detailOrder) return;
    if (selectedRefundLines.length === 0) {
      toast.error(t("orders.refundFailed"), t("orders.refundNothingSelected"));
      return;
    }
    setRefunding(true);
    try {
      const preset = refundCategory ? refundPresets.find((p) => p.id === refundCategory) : undefined;
      const detail = refundReason.trim();
      let reason = "";
      if (refundCategory === "custom") {
        reason = detail;
      } else if (preset) {
        reason = detail ? `${preset.label} - ${detail}` : preset.label;
      }

      // Send the chosen per-line quantities (base units). Omitting items on
      // the wire means "refund everything", but sending explicit quantities
      // keeps partial refunds exact and idempotent.
      const items = selectedRefundLines.map((l) => ({ id: l.item.id, quantity: l.qty }));
      const isPartial = items.some((l) => {
        const it = detailOrder.items.find((i) => i.id === l.id)!;
        return l.quantity < lineRemaining(it) - 1e-9;
      });

      const res = await fetch(`/api/orders/${detailOrder.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason || undefined,
          items,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(t("orders.refundFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }

      const data = await res.json();
      setRefundOpen(false);
      setRefundCategory("");
      setRefundReason("");
      setRefundQty({});
      setDetailOrder(null);
      fetchOrders();
      if (isPartial || data.status === "partially_refunded") {
        toast.success(t("orders.partialRefundProcessed"), t("orders.refundStockNote"));
      } else {
        toast.success(t("orders.refundProcessed"), t("orders.refundStockNote"));
      }
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setRefunding(false);
    }
  }

  // Preset refund categories (localized labels by default; admin-defined
  // strings from Settings when configured). Stored as text so the Refunds
  // ledger + reason breakdown stay readable in any language.
  const refundPresets = React.useMemo(() => {
    if (storedPresets.length > 0) {
      return storedPresets.map((label) => ({ id: label, label }));
    }
    return [
      { id: "returned", label: t("orders.refundReasonPreset.returned") },
      { id: "duplicate", label: t("orders.refundReasonPreset.duplicate") },
      { id: "damaged", label: t("orders.refundReasonPreset.damaged") },
      { id: "wrongItem", label: t("orders.refundReasonPreset.wrongItem") },
      { id: "quality", label: t("orders.refundReasonPreset.quality") },
    ];
  }, [storedPresets, t]);

  // Update status
  async function updateStatus(orderId: string, status: string) {
    try {
      await fetch(`/api/orders/${orderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setDetailOrder(null);
      fetchOrders();
      toast.success(t("orders.updated"), `${t("orders.statusChangedTo")} ${t(`orders.${status}`)}.`);
    } catch (e) {
      console.error(e);
      toast.error(t("orders.updateFailed"));
    }
  }

  // ── Derived view state ─────────────────────────────────────────
  const hasFilters = Boolean(search || statusFilter || paymentFilter || dateFrom || dateTo);

  function clearAllFilters() {
    setSearchInput("");
    setSearch("");
    setStatusFilter("");
    setPaymentFilter("");
    applyDatePreset("all");
  }

  // ── Saved filter views ─────────────────────────────────────────
  // Built-in workviews (all / today / open dues / pending / refunds) plus
  // up to 12 user-saved filter combinations persisted per browser. Views
  // are pure filter snapshots — applying one just re-runs the query.
  interface SavedView {
    id: string;
    name: string;
    filters: { search: string; status: string; payment: string; dateFrom: string; dateTo: string };
  }
  const ORDERS_VIEWS_KEY = "elite-pos-orders-views";
  const MAX_SAVED_VIEWS = 12;

  const [savedViews, setSavedViews] = React.useState<SavedView[]>([]);
  const [viewsOpen, setViewsOpen] = React.useState(false);
  const [savingView, setSavingView] = React.useState(false);
  const [viewName, setViewName] = React.useState("");
  const viewsRef = React.useRef<HTMLDivElement>(null);

  // Load persisted views once (tolerating corrupted/legacy payloads).
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(ORDERS_VIEWS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      setSavedViews(
        arr
          .filter(
            (v): v is SavedView =>
              v &&
              typeof v === "object" &&
              typeof v.id === "string" &&
              typeof v.name === "string" &&
              v.filters &&
              typeof v.filters === "object"
          )
          .slice(0, MAX_SAVED_VIEWS)
      );
    } catch {
      /* ignore malformed stored value */
    }
  }, []);

  function persistViews(views: SavedView[]) {
    setSavedViews(views);
    try {
      localStorage.setItem(ORDERS_VIEWS_KEY, JSON.stringify(views));
    } catch {
      /* storage blocked or full — views stay session-only */
    }
  }

  // Close the views popover on outside click or Escape.
  React.useEffect(() => {
    if (!viewsOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (viewsRef.current && !viewsRef.current.contains(e.target as Node)) {
        setViewsOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setViewsOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [viewsOpen]);

  /** Apply a user-saved view's exact filter snapshot. */
  function applyView(view: SavedView) {
    setSearchInput(view.filters.search);
    setSearch(view.filters.search);
    setStatusFilter(view.filters.status);
    setPaymentFilter(view.filters.payment);
    setDateFrom(view.filters.dateFrom);
    setDateTo(view.filters.dateTo);
    setDatePreset(view.filters.dateFrom || view.filters.dateTo ? "custom" : "all");
    setViewsOpen(false);
    toast.success(t("orders.viewApplied"), view.name);
  }

  /** Apply a built-in view. Built-ins are resolved at click time so
   *  date-based ones ("Today") always use the current day. */
  function applyBuiltinView(id: string) {
    clearAllFilters();
    if (id === "builtin:today") {
      const day = isoDay(new Date());
      setDateFrom(day);
      setDateTo(day);
      setDatePreset("today");
    } else if (id === "builtin:dues") {
      setPaymentFilter("withDue");
    } else if (id === "builtin:pending") {
      setStatusFilter("pending");
    } else if (id === "builtin:refunds") {
      // Comma-separated statuses — the API filters either refund state.
      setStatusFilter("refunded,partially_refunded");
    }
    setViewsOpen(false);
  }

  function saveCurrentView() {
    const name = viewName.trim();
    if (!name) return;
    const view: SavedView = {
      id: `view:${Date.now().toString(36)}`,
      name,
      filters: { search, status: statusFilter, payment: paymentFilter, dateFrom, dateTo },
    };
    // Replace any previous view with the same name; keep the newest first.
    persistViews([view, ...savedViews.filter((v) => v.name !== name)].slice(0, MAX_SAVED_VIEWS));
    setViewName("");
    setSavingView(false);
    toast.success(t("orders.viewSaved"), name);
  }

  function deleteView(id: string) {
    persistViews(savedViews.filter((v) => v.id !== id));
    toast.success(t("orders.viewDeleted"));
  }

  // Which view (if any) matches the current filters? Built-ins win over
  // saved views so "All orders" is always detected; "Today" compares
  // against the actual current day.
  const todayStr = isoDay(new Date());
  const activeViewId = React.useMemo<string | null>(() => {
    const noSearch = !search;
    const noDates = !dateFrom && !dateTo;
    if (noSearch && noDates && !statusFilter && !paymentFilter) return "builtin:all";
    if (noSearch && dateFrom === todayStr && dateTo === todayStr && !statusFilter && !paymentFilter)
      return "builtin:today";
    if (noSearch && noDates && !statusFilter && paymentFilter === "withDue") return "builtin:dues";
    if (noSearch && noDates && statusFilter === "pending" && !paymentFilter) return "builtin:pending";
    if (noSearch && noDates && statusFilter === "refunded,partially_refunded" && !paymentFilter)
      return "builtin:refunds";
    const saved = savedViews.find(
      (v) =>
        v.filters.search === search &&
        v.filters.status === statusFilter &&
        v.filters.payment === paymentFilter &&
        v.filters.dateFrom === dateFrom &&
        v.filters.dateTo === dateTo
    );
    return saved ? saved.id : null;
  }, [search, statusFilter, paymentFilter, dateFrom, dateTo, savedViews, todayStr]);

  const activeViewName =
    activeViewId === "builtin:all"
      ? t("orders.viewAll")
      : activeViewId === "builtin:today"
        ? t("orders.viewToday")
        : activeViewId === "builtin:dues"
          ? t("orders.viewOpenDues")
          : activeViewId === "builtin:pending"
            ? t("orders.viewPending")
            : activeViewId === "builtin:refunds"
              ? t("orders.refundsCombo")
              : activeViewId
                ? savedViews.find((v) => v.id === activeViewId)?.name ?? t("orders.customView")
                : t("orders.customView");

  // KPI cards — computed over the full filtered dataset (same numbers the
  // export/print header shows), so they stay truthful while paging.
  const kpiRevenue = React.useMemo(() => allOrders.reduce((s, o) => s + o.total, 0), [allOrders]);
  const kpiDues = React.useMemo(() => allOrders.reduce((s, o) => s + (o.dueAmount ?? 0), 0), [allOrders]);
  const kpiAvg = total > 0 ? Math.round(kpiRevenue / total) : 0;
  const kpiCreditOrders = React.useMemo(
    () => allOrders.filter((o) => (o.dueAmount ?? 0) > 0).length,
    [allOrders]
  );

  const periodLabel = hasFilters
    ? `${t("common.filter")}: ${[
        search,
        statusFilter,
        paymentFilter,
        [dateFrom, dateTo].filter(Boolean).join(" → "),
      ]
        .filter(Boolean)
        .join(" · ")}`
    : undefined;

  function datePresetClass(active: boolean): string {
    return active
      ? "rounded-lg bg-neu-accent-solid px-2.5 py-1.5 text-xs font-medium text-white transition-colors"
      : "rounded-lg bg-neu-sunken px-2.5 py-1.5 text-xs font-medium text-neu-muted transition-colors";
  }

  // Shared empty state for table + mobile list
  const emptyStateNode = (
    <EmptyState
      bare
      icon={
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
        </svg>
      }
      title={hasFilters ? t("orders.noMatch") : t("orders.empty")}
      description={hasFilters ? t("common.noMatchHint") : t("orders.emptyHint")}
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
        title={t("orders.title")}
        description={`${total} ${t("orders.totalCount")}`}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("orders.title") },
        ]}
        actions={
          <ExportMenu<Order>
            fileStem="orders"
            sheetName="Orders"
            rows={allOrders}
            columns={orderExportColumns}
            disabled={total === 0}
            period={periodLabel}
            printKpis={[
              { label: t("orders.totalCount"), value: String(total) },
              { label: t("orders.total"), value: formatCurrency(kpiRevenue) },
              { label: t("orders.dueBadge"), value: formatCurrency(kpiDues), tone: "warning" },
            ]}
            onPrint={printLedger}
          />
        }
      />

      {/* ─── KPI stat cards ─── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading || allLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
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
              label={t("reports.totalOrders")}
              value={String(total)}
              icon="bag"
              tone="brand"
            />
            <StatCard
              label={t("reports.revenue")}
              value={formatCurrency(kpiRevenue)}
              icon="cash"
              tone="success"
            />
            <StatCard
              label={t("reports.avgOrderValue")}
              value={formatCurrency(kpiAvg)}
              icon="chart"
              tone="info"
            />
            <StatCard
              label={t("customers.totalOutstanding")}
              value={formatCurrency(kpiDues)}
              icon="wallet"
              tone="warning"
              sub={kpiCreditOrders > 0 ? t("orders.kpiDuesSub", { count: kpiCreditOrders }) : undefined}
            />
          </>
        )}
      </div>

      {/* ─── Filters ─── */}
      <Card>
        <CardContent className="space-y-3 p-4">
          {/* Saved views — built-in workviews + user-saved filter combos */}
          <div ref={viewsRef} className="relative">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-neu-faint">
                {t("orders.views")}
              </span>
              <button
                type="button"
                onClick={() => setViewsOpen((v) => !v)}
                aria-expanded={viewsOpen}
                aria-haspopup="listbox"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                  activeViewId
                    ? "bg-neu-accent-solid text-white"
                    : "bg-neu-sunken text-neu-muted"
                )}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                </svg>
                <span className="max-w-[180px] truncate">{activeViewName}</span>
                <svg className={cn("h-3 w-3 transition-transform", viewsOpen && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
              {hasFilters && !activeViewId?.startsWith("builtin:") && (
                <button
                  type="button"
                  onClick={() => setSavingView((s) => !s)}
                  className="inline-flex items-center gap-1 rounded-lg bg-neu-sunken px-2.5 py-1.5 text-xs font-medium text-neu-muted transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 3.75V16.5L12 14.25 7.5 16.5V3.75m9 0H12A2.25 2.25 0 109.75 6H7.5a2.25 2.25 0 00-2.25 2.25v13.5" />
                  </svg>
                  {t("orders.saveView")}
                </button>
              )}
            </div>
            {viewsOpen && (
              <div className="absolute z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-neu-hairline bg-neu-bg p-1.5 shadow-xl">
                {/* Built-ins */}
                {[
                  { id: "builtin:all", label: t("orders.viewAll"), icon: "M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6h.008v.008H3.75V6zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.008v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.008v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" },
                  { id: "builtin:today", label: t("orders.viewToday"), icon: "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" },
                  { id: "builtin:dues", label: t("orders.viewOpenDues"), icon: "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" },
                  { id: "builtin:pending", label: t("orders.viewPending"), icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" },
                  { id: "builtin:refunds", label: t("orders.refundsCombo"), icon: "M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" },
                ].map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => applyBuiltinView(v.id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors",
                      activeViewId === v.id
                        ? "bg-neu-accent-wash font-medium text-neu-accent-ink-strong"
                        : "text-neu-primary hover:bg-neu-sunken"
                    )}
                  >
                    <svg className="h-4 w-4 shrink-0 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={v.icon} />
                    </svg>
                    <span className="flex-1 truncate">{v.label}</span>
                    {activeViewId === v.id && (
                      <svg className="h-4 w-4 shrink-0 text-neu-accent-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                  </button>
                ))}
                {/* User-saved views */}
                {savedViews.length > 0 && (
                  <>
                    <div className="mx-1.5 my-1.5 h-px bg-neu-sunken" />
                    <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-neu-faint">
                      {t("orders.myViews")}
                    </div>
                    {savedViews.map((v) => (
                      <div
                        key={v.id}
                        className={cn(
                          "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                          activeViewId === v.id
                            ? "bg-neu-accent-wash"
                            : "hover:bg-neu-sunken"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => applyView(v)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
                        >
                          <svg className="h-4 w-4 shrink-0 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.282M12 3a8.997 8.997 0 00-7.843 4.282" />
                          </svg>
                          <span
                            className={cn(
                              "flex-1 truncate",
                              activeViewId === v.id ? "font-medium text-neu-accent-ink-strong" : "text-neu-primary"
                            )}
                          >
                            {v.name}
                          </span>
                          {activeViewId === v.id && (
                            <svg className="h-4 w-4 shrink-0 text-neu-accent-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteView(v.id);
                          }}
                          title={t("orders.deleteView")}
                          className="shrink-0 rounded-md p-1 text-neu-faint opacity-0 transition-opacity hover:bg-neu-wash-red hover:text-neu-ink-red focus:opacity-100 group-hover:opacity-100"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {/* Save current filters inline */}
                {savingView && (
                  <>
                    <div className="mx-1.5 my-1.5 h-px bg-neu-sunken" />
                    <div className="flex items-center gap-2 px-1.5 pb-1">
                      <input
                        autoFocus
                        value={viewName}
                        maxLength={40}
                        onChange={(e) => setViewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveCurrentView();
                          if (e.key === "Escape") {
                            setSavingView(false);
                            setViewName("");
                          }
                        }}
                        placeholder={t("orders.viewNamePlaceholder")}
                        aria-label={t("orders.saveView")}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-neu-hairline bg-neu-bg px-2.5 text-sm text-neu-primary neu-focus"
                      />
                      <Button size="xs" onClick={saveCurrentView} disabled={!viewName.trim()}>
                        {t("common.save")}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              placeholder={t("orders.searchPlaceholder")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              leftIcon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
              wrapperClassName="w-full sm:w-80"
            />
            <select
              className={selectFieldClass}
              aria-label={t("orders.status")}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">{t("orders.allStatus")}</option>
              <option value="completed">{t("orders.completed")}</option>
              <option value="pending">{t("orders.pending")}</option>
              <option value="confirmed">{t("orders.confirmed")}</option>
              <option value="processing">{t("orders.processing")}</option>
              <option value="cancelled">{t("orders.cancelled")}</option>
              <option value="refunded">{t("orders.refunded")}</option>
              <option value="partially_refunded">{t("orders.partiallyRefunded")}</option>
            </select>
            <select
              className={selectFieldClass}
              aria-label={t("orders.payment")}
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value)}
            >
              <option value="">{t("orders.allPayment")}</option>
              <option value="withDue">{t("orders.withOpenDue")}</option>
              <option value="paid">{t("orders.fullyPaid")}</option>
            </select>
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
          {/* Date range — same pattern as the Refunds ledger */}
          <div className="flex flex-wrap items-center gap-2.5 border-t border-neu-hairline pt-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-neu-faint">
              {t("orders.dateRange")}
            </span>
            {[
              { key: "all", label: t("orders.allTime") },
              { key: "today", label: t("orders.today") },
              { key: "7", label: t("orders.last7") },
              { key: "30", label: t("orders.last30") },
            ].map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyDatePreset(p.key)}
                className={datePresetClass(datePreset === p.key)}
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
                setDatePreset("custom");
              }}
              aria-label={t("orders.dateRange")}
              className={selectFieldClass}
            />
            <span className="text-sm text-neu-faint">{t("reports.to")}</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                setDateTo(e.target.value);
                setDatePreset("custom");
              }}
              aria-label={t("orders.dateRange")}
              className={selectFieldClass}
            />
          </div>
        </CardContent>
      </Card>

      {/* ─── Orders list ─── */}
      <Card>
        {/* Bulk selection toolbar */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neu-hairline bg-neu-accent-wash/60 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neu-accent-solid text-xs font-bold text-white">
                {selectedIds.size}
              </span>
              <span className="font-medium text-neu-primary">{t("orders.selected")}</span>
              <span className="hidden text-neu-faint sm:inline">
                · {formatCurrency(selectedTotal)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setBulkRefundOpen(true)}
                disabled={selectedIds.size === 0}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                </svg>
                {t("orders.bulkRefund")}
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                {t("common.clear")}
              </Button>
            </div>
          </div>
        )}

        {/* Mobile: stacked order cards */}
        <div className="divide-y divide-neu-hairline md:hidden">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton h-20 rounded-xl"
                  style={{ animationDelay: `${i * 60}ms` }}
                />
              ))}
            </div>
          ) : loadError ? (
            errorStateNode
          ) : orders.length === 0 ? (
            emptyStateNode
          ) : (
            orders.map((order) => {
              const selectable =
                order.status !== "refunded" &&
                order.status !== "cancelled" &&
                order.status !== "partially_refunded";
              const checked = selectedIds.has(order.id);
              return (
                <div
                  key={order.id}
                  className={cn(
                    "cursor-pointer px-4 py-3.5 transition-colors hover:bg-neu-sunken/60",
                    checked && "bg-neu-accent-wash/50"
                  )}
                  onClick={() => viewDetail(order)}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 rounded border-neu-hairline accent-neu-accent-solid"
                      checked={checked}
                      disabled={!selectable}
                      onChange={() => toggleSelect(order.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`${t("orders.selectOrder")} ${order.orderNumber}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-[13px] font-semibold text-neu-primary">
                          {order.orderNumber}
                        </span>
                        <Badge variant={statusColors[order.status] ?? "default"} size="sm">
                          {t(`orders.${order.status}`)}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate text-sm text-neu-muted">
                        {order.customer?.name ?? t("orders.walkIn")} · {order.user.name}
                      </p>
                      <p className="mt-0.5 text-xs text-neu-faint">
                        {formatDate(order.createdAt, "medium")} · {formatTime(order.createdAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="text-sm font-bold tabular-nums text-neu-primary">
                        {formatCurrency(order.total)}
                      </p>
                      {(order.dueAmount ?? 0) > 0 && (
                        <p className="text-[10px] font-medium tabular-nums text-neu-ink-amber">
                          {t("orders.dueBadge")}: {formatCurrency(order.dueAmount ?? 0)}
                        </p>
                      )}
                      {order.paymentStatus && order.paymentStatus !== "paid" && (
                        <Badge
                          variant={order.paymentStatus === "unpaid" ? "danger" : "warning"}
                          size="sm"
                          className="mt-1"
                        >
                          {t(`orders.paymentStatus.${order.paymentStatus}`)}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop: full table (progressively hides low-priority columns) */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neu-hairline bg-neu-sunken">
                <th className="w-10 px-4 py-3 text-start">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-neu-hairline accent-neu-accent-solid"
                    checked={allPageSelected}
                    onChange={toggleSelectAll}
                    aria-label={t("orders.selectAll")}
                  />
                </th>
                <th className="whitespace-nowrap px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("orders.orderNumber")}</th>
                <th className="whitespace-nowrap px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("orders.customer")}</th>
                <th className="hidden whitespace-nowrap px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-neu-faint lg:table-cell">{t("orders.cashier")}</th>
                <th className="whitespace-nowrap px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("orders.date")}</th>
                <th className="hidden whitespace-nowrap px-4 py-3 text-end text-xs font-semibold uppercase tracking-wider text-neu-faint xl:table-cell">{t("orders.items")}</th>
                <th className="whitespace-nowrap px-4 py-3 text-end text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("orders.total")}</th>
                <th className="whitespace-nowrap px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("orders.status")}</th>
                <th className="hidden whitespace-nowrap px-4 py-3 text-end text-xs font-semibold uppercase tracking-wider text-neu-faint lg:table-cell">{t("orders.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neu-hairline">
              {loading ? (
                <TableSkeleton rows={8} />
              ) : loadError ? (
                <tr>
                  <td colSpan={9} className="px-4 py-0">
                    {errorStateNode}
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-0">
                    {emptyStateNode}
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  const selectable =
                    order.status !== "refunded" &&
                    order.status !== "cancelled" &&
                    order.status !== "partially_refunded";
                  const checked = selectedIds.has(order.id);
                  return (
                  <tr key={order.id} className={cn("hover:bg-neu-sunken/50 cursor-pointer", checked && "bg-neu-accent-wash/50")} onClick={() => viewDetail(order)}>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-neu-hairline accent-neu-accent-solid"
                        checked={checked}
                        disabled={!selectable}
                        onChange={() => toggleSelect(order.id)}
                        aria-label={`${t("orders.selectOrder")} ${order.orderNumber}`}
                      />
                    </td>
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
                    <td className="hidden px-4 py-3 text-sm text-neu-muted lg:table-cell">{order.user.name}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <p className="text-xs font-medium text-neu-muted">{formatDate(order.createdAt, "medium")}</p>
                      <p className="text-[11px] tabular-nums text-neu-faint">{formatTime(order.createdAt)}</p>
                    </td>
                    <td className="hidden px-4 py-3 text-end text-sm tabular-nums text-neu-primary xl:table-cell">{itemsLabel(order)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-end text-sm font-semibold tabular-nums text-neu-primary">
                      {formatCurrency(order.total)}
                      {/* Same reason as the products table: the due line is
                          RESERVED rather than conditional, so a row with dues
                          (which is the taller one) does not stretch the table.
                          It is pinned to 14px so the reserved line costs less
                          than the raggedness did. */}
                      <span className="block text-[10px] leading-[14px] font-medium tabular-nums text-neu-ink-amber">
                        {(order.dueAmount ?? 0) > 0
                          ? `${t("orders.dueBadge")}: ${formatCurrency(order.dueAmount ?? 0)}`
                          : "\u00A0"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-center">
                      {/* Side by side, not stacked. Stacking the payment badge
                          under the status badge made every order with a balance
                          a row 12px taller than the rest — the row height was
                          encoding the payment status, which is what the badge
                          itself is for. In a row they cost the same 22px
                          whether the order has a balance or not. */}
                      <span className="inline-flex items-center justify-center gap-1.5">
                        <Badge variant={statusColors[order.status] ?? "default"} size="sm">{t(`orders.${order.status}`)}</Badge>
                        {order.paymentStatus && order.paymentStatus !== "paid" && (
                          <Badge variant={order.paymentStatus === "unpaid" ? "danger" : "warning"} size="sm">
                            {t(`orders.paymentStatus.${order.paymentStatus}`)}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-end lg:table-cell">
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); viewDetail(order); }}>
                        {t("orders.viewDetails")}
                      </Button>
                    </td>
                  </tr>
                  );
                })
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

      {/* ═══ ORDER DETAIL MODAL ═══ */}
      <Dialog open={Boolean(detailOrder)} onOpenChange={(o) => !o && setDetailOrder(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            {detailOrder && !detailLoading ? (
              <div className="flex items-center justify-between w-full gap-3">
                <div className="min-w-0">
                  <DialogTitle className="truncate">{t("orders.orderNumber")} {detailOrder.orderNumber}</DialogTitle>
                  <p className="mt-1 text-sm text-neu-faint">
                    {formatDate(detailOrder.createdAt, "full")} · {formatTime(detailOrder.createdAt)}
                  </p>
                </div>
                <Badge variant={statusColors[detailOrder.status] ?? "default"} size="lg" className="shrink-0">
                  {t(`orders.${detailOrder.status}`)}
                </Badge>
              </div>
            ) : (
              <div className="flex w-full items-center justify-between gap-3">
                <div className="skeleton h-7 w-48" />
                <div className="skeleton h-6 w-24 rounded-full" />
              </div>
            )}
          </DialogHeader>

          <DialogBody className="space-y-4">
            {detailLoading ? (
              <div className="space-y-4">
                <div className="skeleton h-16 w-full rounded-lg" />
                <div className="grid grid-cols-2 gap-3">
                  <div className="skeleton h-14 w-full rounded-lg" />
                  <div className="skeleton h-14 w-full rounded-lg" />
                </div>
                <div className="skeleton h-44 w-full rounded-lg" />
                <div className="skeleton h-24 w-full rounded-lg" />
              </div>
            ) : detailOrder ? (
              <>
                {/* Refund reason banner (for refunded + partially refunded orders) */}
                {(detailOrder.status === "refunded" || detailOrder.status === "partially_refunded") && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-neu-ink-amber/20 bg-neu-wash-amber p-3 text-sm">
                    <svg className="mt-0.5 h-4 w-4 shrink-0 text-neu-ink-amber" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-neu-ink-amber">
                        {t("refunds.reason")}
                        {detailOrder.status === "partially_refunded" && (
                          <span className="ms-2 font-normal text-neu-ink-amber">
                            · {t("orders.partiallyRefunded")} — {formatCurrency(detailOrder.refundedAmount ?? 0)} {t("orders.refundedSoFar")}
                          </span>
                        )}
                      </p>
                      <p className="text-neu-ink-amber">{detailOrder.refundReason || t("refunds.noReason")}</p>
                      {detailOrder.refundedBy && (
                        <p className="mt-0.5 text-xs text-neu-ink-amber">
                          {t("refunds.refundedBy")}: {detailOrder.refundedBy.name}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Customer & Cashier */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
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
                </div>

                {/* Items */}
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
                      const isPartiallyRefundedLine = refunded > 0 && refunded < item.quantity - 1e-9;
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
                                <span className={isPartiallyRefundedLine ? "text-neu-ink-amber" : "text-neu-ink-green"}>
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
                  <div className="flex border-t border-neu-hairline pt-2 text-lg font-bold text-neu-primary">
                    <span>{t("orders.total")}</span>
                    <span className="ms-auto tabular-nums">{formatCurrency(detailOrder.total)}</span>
                  </div>
                  {/* Credit (khata) settlement lines */}
                  {(detailOrder.dueAmount ?? 0) > 0 && (
                    <div className="flex justify-between text-sm font-semibold text-neu-ink-amber">
                      <span>{t("orders.dueBadge")}</span>
                      <span className="tabular-nums">{formatCurrency(detailOrder.dueAmount ?? 0)}</span>
                    </div>
                  )}
                  {detailOrder.paidAmount > 0 && (
                    <div className="flex justify-between text-sm text-neu-muted">
                      <span>{t("orders.paidLabel")}</span>
                      <span className="tabular-nums">{formatCurrency(detailOrder.paidAmount)}</span>
                    </div>
                  )}
                  {detailOrder.changeAmount > 0 && (
                    <div className="flex justify-between text-sm text-neu-ink-green">
                      <span>{t("orders.changeLabel")}</span>
                      <span className="tabular-nums">{formatCurrency(detailOrder.changeAmount)}</span>
                    </div>
                  )}
                </div>

                {/* Order notes */}
                {detailOrder.notes && (
                  <div className="rounded-lg border border-neu-hairline bg-neu-sunken/60 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-neu-faint">{t("orders.notes")}</p>
                    <p className="mt-0.5 whitespace-pre-line text-sm text-neu-primary">{detailOrder.notes}</p>
                  </div>
                )}

                {/* Payment Info */}
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neu-faint">{t("orders.payment")}</p>
                  <div className="flex flex-wrap gap-2">
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

          {/* Footer Actions */}
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between dark:bg-neu-sunken/40">
            {detailOrder && !detailLoading ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {/* Print receipt button — shows for completed/non-cancelled orders */}
                  {(detailOrder.status === "completed" || detailOrder.status === "confirmed" || detailOrder.status === "processing") && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        let settings: POSReceiptSettings = { storeName: "Store" };
                        try {
                          const res = await fetch("/api/settings");
                          const data = await res.json();
                          const s = data.settings ?? {};
                          settings = {
                            storeName: s.storeName || "Store",
                            storeAddress: s.storeAddress || undefined,
                            storePhone: s.storePhone || undefined,
                            receiptHeader: s.receiptHeader || undefined,
                            receiptFooter: s.receiptFooter || undefined,
                            receiptQrPayment: s.receiptQrPayment || undefined,
                          };
                        } catch { /* use default */ }
                        const receiptOrder: POSReceiptOrder = {
                          orderNumber: detailOrder.orderNumber,
                          createdAt: detailOrder.createdAt,
                          subtotal: detailOrder.subtotal,
                          taxAmount: detailOrder.taxAmount,
                          discountAmount: detailOrder.discountAmount,
                          total: detailOrder.total,
                          paymentMethod: detailOrder.payments[0]?.method ?? "cash",
                          amountPaid: detailOrder.paidAmount,
                          changeDue: detailOrder.changeAmount,
                          user: detailOrder.user,
                          customer: detailOrder.customer,
                          items: detailOrder.items.map((it) => ({
                            productName: it.productName,
                            quantity: it.quantity,
                            unit: it.unit,
                            unitPrice: it.unitPrice,
                            total: it.total,
                          })),
                        };
                        printPOSReceipt(receiptOrder, settings);
                      }}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5z" />
                      </svg>
                      {t("orders.printReceipt")}
                    </Button>
                  )}
                  {/* Print refund receipt — shows for refunded/partially refunded orders */}
                  {(detailOrder.status === "refunded" || detailOrder.status === "partially_refunded") && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => printRefundReceiptsForOrders([detailOrder], t)}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5z" />
                      </svg>
                      {t("orders.printReceipt")}
                    </Button>
                  )}
                  {detailOrder.status === "refunded" && (
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
                      {t("orders.sellAgain")}
                    </Button>
                  )}
                  {detailOrder.status === "pending" && (
                    <Button variant="success" size="sm" onClick={() => updateStatus(detailOrder.id, "confirmed")}>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      {t("orders.confirmOrder")}
                    </Button>
                  )}
                  {(detailOrder.status === "pending" || detailOrder.status === "confirmed" || detailOrder.status === "processing" || detailOrder.status === "completed" || detailOrder.status === "partially_refunded") && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => openRefundDialog(detailOrder)}
                      title={detailOrder.status === "partially_refunded" ? t("orders.refundRemainingHint") : undefined}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                      </svg>
                      {detailOrder.status === "partially_refunded" ? t("orders.refundRemaining") : t("orders.refund")}
                    </Button>
                  )}
                </div>
                <Button variant="secondary" size="sm" onClick={() => setDetailOrder(null)}>
                  {t("common.close")}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setDetailOrder(null)}>
                {t("common.close")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ REFUND CONFIRMATION MODAL ═══ */}
      <Dialog open={refundOpen} onOpenChange={(o) => { if (!o) setRefundOpen(false); }}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("orders.processRefund")}</DialogTitle>
            {detailOrder && (
              <DialogDescription>
                #{detailOrder.orderNumber} · {formatCurrency(detailOrder.total)}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogBody className="space-y-4">
            {detailOrder && (
              <div className="rounded-lg bg-neu-wash-red p-3 text-sm text-neu-ink-red">
                {t("orders.refundNotice")} <span className="font-bold">{formatCurrency(detailOrder.total)}</span> {t("orders.forOrder")} #{detailOrder.orderNumber}. {t("orders.refundStockNote")}
              </div>
            )}

            {/* Per-item refund quantities (partial refunds) */}
            {detailOrder && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-neu-primary">
                  {t("orders.refundItemsTitle")}
                </label>
                <p className="mb-2 text-xs text-neu-faint">{t("orders.refundItemsDesc")}</p>
                <div className="max-h-52 divide-y divide-neu-hairline overflow-y-auto rounded-lg border border-neu-hairline">
                  {detailOrder.items.map((item) => {
                    const remaining = lineRemaining(item);
                    const value = refundQty[item.id] ?? "";
                    const qty = parseFloat(value) || 0;
                    const lineTotal = remaining > 0 ? Math.round((item.total * Math.min(qty, remaining)) / item.quantity) : 0;
                    return (
                      <div key={item.id} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-neu-primary">{item.productName}</p>
                          <p className="text-[11px] tabular-nums text-neu-faint">
                            {t("orders.refundAvailable")}: {lineQtyLabel(remaining, item.unit)}
                            {item.refundedQuantity ? ` · ${lineQtyLabel(item.refundedQuantity, item.unit)} ${t("orders.refundedSoFar")}` : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            max={remaining}
                            step={Number.isInteger(remaining) ? "1" : "0.001"}
                            value={value}
                            onChange={(e) =>
                              setRefundQty((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                            aria-label={`${t("orders.refundQtyLabel")} ${item.productName}`}
                            className="h-8 w-20 rounded-lg border border-neu-hairline bg-neu-bg px-2 text-end text-sm tabular-nums text-neu-primary neu-focus"
                          />
                          <span className="w-16 text-end text-xs font-semibold tabular-nums text-neu-ink-red">
                            −{formatCurrency(lineTotal)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-xs text-neu-faint">
                    {selectedRefundLines.length} {t("orders.linesSelected")}
                  </p>
                  <p className="text-sm font-bold text-neu-ink-red">
                    {t("orders.refundPreview")}: −{formatCurrency(refundPreview)}
                  </p>
                </div>
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-sm font-medium text-neu-primary">
                {t("orders.refundReason")} ({t("common.optional")})
              </label>
              <select
                value={refundCategory}
                onChange={(e) => setRefundCategory(e.target.value)}
                className={`${selectFieldClass} w-full`}
              >
                <option value="">{t("orders.refundReasonChoose")}</option>
                {refundPresets.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                <option value="custom">{t("orders.refundReasonCustom")}</option>
              </select>
            </div>
            {refundCategory && (
              <Input
                label={`${refundCategory === "custom" ? t("orders.refundReason") : t("orders.reasonDetails")} (${t("common.optional")})`}
                placeholder={
                  refundCategory === "custom"
                    ? t("orders.refundReasonPlaceholder")
                    : t("orders.reasonDetailsPlaceholder")
                }
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
              />
            )}
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => { setRefundOpen(false); setRefundCategory(""); setRefundReason(""); setRefundQty({}); }}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={refunding} onClick={handleRefund} disabled={selectedRefundLines.length === 0}>
              {t("orders.processRefund")} · −{formatCurrency(refundPreview)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ BULK REFUND CONFIRMATION MODAL ═══ */}
      <Dialog open={bulkRefundOpen} onOpenChange={(o) => { if (!o) setBulkRefundOpen(false); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("orders.bulkRefund")}</DialogTitle>
            <DialogDescription>
              {selectedIds.size} {t("orders.totalCount")} · {formatCurrency(selectedTotal)}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="rounded-lg bg-neu-wash-red p-3 text-sm text-neu-ink-red">
              {t("orders.bulkRefundNotice")}{" "}
              <span className="font-bold">{selectedIds.size}</span>{" "}
              {t("orders.totalCount")} ·{" "}
              <span className="font-bold">{formatCurrency(selectedTotal)}</span>
              . {t("orders.refundStockNote")}
            </div>
            {selectedOrders.length > 0 && (
              <div className="max-h-28 divide-y divide-neu-hairline overflow-y-auto rounded-lg border border-neu-hairline">
                {selectedOrders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                    <span className="font-mono text-xs text-neu-primary">{o.orderNumber}</span>
                    <span className="font-semibold tabular-nums text-neu-primary">{formatCurrency(o.total)}</span>
                  </div>
                ))}
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neu-primary">
                {t("orders.refundReason")} ({t("common.optional")})
              </label>
              <select
                value={bulkCategory}
                onChange={(e) => setBulkCategory(e.target.value)}
                className={`${selectFieldClass} w-full`}
              >
                <option value="">{t("orders.refundReasonChoose")}</option>
                {refundPresets.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                <option value="custom">{t("orders.refundReasonCustom")}</option>
              </select>
            </div>
            {bulkCategory && (
              <Input
                label={`${bulkCategory === "custom" ? t("orders.refundReason") : t("orders.reasonDetails")} (${t("common.optional")})`}
                placeholder={
                  bulkCategory === "custom"
                    ? t("orders.refundReasonPlaceholder")
                    : t("orders.reasonDetailsPlaceholder")
                }
                value={bulkDetail}
                onChange={(e) => setBulkDetail(e.target.value)}
              />
            )}
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => { setBulkRefundOpen(false); setBulkCategory(""); setBulkDetail(""); }}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={bulkRefunding} onClick={handleBulkRefund}>
              {t("orders.bulkRefund")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
