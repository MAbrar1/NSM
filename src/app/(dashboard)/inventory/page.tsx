"use client";

import * as React from "react";
import { cn, formatCurrency } from "@/lib/utils";
import { lineQtyLabel, trimNumber, WHOLE_UNITS } from "@/lib/units";
import { PageHeader } from "@/components/layout/page-header";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { useWarehouseStore } from "@/stores/warehouse-store";
import { broadcastStockChange } from "@/hooks/use-stock-sync";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SortableTh } from "@/components/ui/sortable-th";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/stores/toast-store";
import { downloadCsv, downloadExcel, sumFormulaCell, type ExcelSheet } from "@/lib/files/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { fetchReportSettings, printReport } from "@/lib/print-report";
import { useHardwareScanner } from "@/hooks/use-hardware-scanner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";

/* ═══════════════════════════════════════════════════════════════
   INVENTORY PAGE
   Tabbed interface for: Stock Levels, Movements, Transfers with
   inline stock adjustment. Desktop tables collapse into
   touch-friendly cards below `md`, all numbers are tabular and
   every amount re-formats with the store currency.
   ═══════════════════════════════════════════════════════════════ */

/* ─── Shared icon paths (heroicons 24 outline) ─────────────────── */
const P = {
  download:
    "M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3",
  upload:
    "M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5",
  swap: "M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5",
  plus: "M12 4v16m8-8H4",
  arrowRight: "M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3",
  clock: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
  search:
    "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z",
  x: "M6 18L18 6M6 6l12 12",
  box: "M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9",
  info: "M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z",
  arrowPath:
    "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99",
  adjust:
    "M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75",
  chart:
    "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  alert:
    "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  minusCircle: "M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z",
  chevronLeft: "M15.75 19.5L8.25 12l7.5-7.5",
  chevronRight: "M8.25 4.5l7.5 7.5-7.5 7.5",
  truck:
    "M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12",
  check: "M4.5 12.75l6 6 9-13.5",
} as const;

/** Tiny stroke-icon helper so tables/cards stay readable. */
function Icon({ path, className = "h-4 w-4" }: { path: string; className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

/** Movement type → icon glyph (chip color follows the quantity sign). */
const MOVEMENT_ICON: Record<string, string> = {
  purchase: P.download,
  po_receive: P.truck,
  sale: P.upload,
  return: P.arrowPath,
  transfer: P.swap,
  adjustment: P.adjust,
  count: P.chart,
  damaged: P.alert,
  expired: P.clock,
};

/** Transfer status → icon glyph. */
const TRANSFER_STATUS_ICON: Record<string, string> = {
  pending: P.clock,
  in_transit: P.truck,
  received: P.check,
  cancelled: P.x,
};

/** Movement types offered in the type filter (mirrors inventory.movement.* i18n). */
const MOVEMENT_TYPES = [
  "purchase",
  "sale",
  "return",
  "adjustment",
  "transfer",
  "damaged",
  "expired",
  "count",
  "po_receive",
] as const;
const MOVEMENTS_PAGE_SIZE = 20;

type Tab = "stock" | "movements" | "transfers";

interface StockItem {
  id: string;
  quantity: number;
  reservedQuantity: number;
  available: number;
  isLowStock: boolean;
  isOutOfStock: boolean;
  stockStatus?: "out" | "low" | "ok";
  stockValue: number;
  product: {
    id: string; name: string; sku: string; barcode?: string | null;
    minStockLevel: number; unitPrice: number; costPrice: number;
    unit?: string; allowFractional?: boolean;
    category: { name: string };
  };
  warehouse: { id: string; name: string; code: string };
}

interface Movement {
  id: string;
  type: string;
  quantity: number;
  notes?: string;
  createdAt: string;
  product: { name: string; sku: string; unit?: string };
  warehouse: { name: string };
  performedBy: { name: string };
}

interface Transfer {
  id: string;
  status: string;
  notes?: string;
  createdAt: string;
  fromWarehouse: { name: string };
  toWarehouse: { name: string };
  createdBy: { name: string };
  items: Array<{
    id: string;
    productId: string;
    quantity: number;
    product?: { name: string; sku: string; unit?: string; allowFractional?: boolean } | null;
  }>;
}

interface TransferProduct {
  id: string;
  name: string;
  sku: string;
  unit?: string;
  allowFractional?: boolean;
  available?: number | null;
}

/** Unit label suffix (" kg") for loose goods; blank for whole units. */
function unitSuffix(unit?: string): string {
  return unit && !WHOLE_UNITS.has(unit) ? ` ${unit}` : "";
}

/** Whole-unit vs loose input semantics for the adjust/transfer dialogs. */
function isLoose(unit?: string, allowFractional?: boolean): boolean {
  return Boolean(allowFractional) || (Boolean(unit) && !WHOLE_UNITS.has(unit!));
}

/** Compact localized date ("Sep 21"). */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact localized date + time ("Sep 21, 14:32"). */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(
    undefined,
    { hour: "2-digit", minute: "2-digit" },
  )}`;
}

/* Shared table header cell. */
const TH = "inv-th";

export default function InventoryPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [activeTab, setActiveTab] = React.useState<Tab>("stock");
  const [stockItems, setStockItems] = React.useState<StockItem[]>([]);

  // Client-side sort over the loaded rows: this tab fetches the WHOLE
  // filtered scope (all=true, no pager), so the full dataset is already in
  // memory — the only correct place to sort it. Money/stock open high→low,
  // text opens A→Z.
  const [stockSort, setStockSort] = React.useState("product.asc");
  const sortedStockItems = React.useMemo(() => {
    const [field, order] = stockSort.split(".");
    const sign = order === "asc" ? 1 : -1;
    const rows = [...stockItems];
    rows.sort((a, b) => {
      switch (field) {
        case "warehouse":
          return sign * (a.warehouse.name ?? "").localeCompare(b.warehouse.name ?? "");
        case "stock":
          return sign * ((a.quantity ?? 0) - (b.quantity ?? 0));
        case "available":
          return sign * ((a.available ?? 0) - (b.available ?? 0));
        case "value":
          return sign * ((a.stockValue ?? 0) - (b.stockValue ?? 0));
        default:
          return sign * (a.product.name ?? "").localeCompare(b.product.name ?? "");
      }
    });
    return rows;
  }, [stockItems, stockSort]);
  function toggleStockSort(field: string) {
    setStockSort((s) => {
      if (s.startsWith(`${field}.`)) {
        return `${field}.${s.endsWith(".asc") ? "desc" : "asc"}`;
      }
      return `${field}.${field === "product" || field === "warehouse" ? "asc" : "desc"}`;
    });
  }
  const [movements, setMovements] = React.useState<Movement[]>([]);
  const [transfers, setTransfers] = React.useState<Transfer[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");

  // Scan-anywhere: a hardware scanner burst filters the stock list to
  // the scanned product/SKU instantly.
  useHardwareScanner({
    onScan: (code) => {
      setSearchInput(code);
      setSearch(code);
    },
  });
  // Server-computed scope-wide tallies for the KPI cards. `stockItems` is only
  // the current page of rows, so deriving the cards from it capped them at the
  // page size and made them move with the search/filter.
  const [stockSummary, setStockSummary] = React.useState({
    stockRows: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
    totalStockValue: 0,
    totalRetailValue: 0,
  });
  const [lowStockOnly, setLowStockOnly] = React.useState(false);
  // Bumped after adjust/transfer mutations so the active tab refetches.
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Movements tab: server-side filters + pagination (API: /api/inventory/movements).
  const [movementWarehouse, setMovementWarehouse] = React.useState("");
  const [movementType, setMovementType] = React.useState("");
  const [movementPage, setMovementPage] = React.useState(1);
  const [movementsMeta, setMovementsMeta] = React.useState({ total: 0, totalPages: 1 });

  // Adjust modal
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [adjustTarget, setAdjustTarget] = React.useState<StockItem | null>(null);
  const [adjustQty, setAdjustQty] = React.useState("");
  const [adjustType, setAdjustType] = React.useState("adjustment");
  const [adjustNotes, setAdjustNotes] = React.useState("");
  const [adjusting, setAdjusting] = React.useState(false);
  const adjustQtyNum = adjustQty.trim() === "" ? NaN : parseFloat(adjustQty);
  const adjustValid = Number.isFinite(adjustQtyNum) && adjustQtyNum !== 0;

  // ── Product movement timeline drawer ────────────────────────────
  const [timelineProduct, setTimelineProduct] = React.useState<StockItem | null>(null);
  const [timeline, setTimeline] = React.useState<Movement[]>([]);
  const [timelineLoading, setTimelineLoading] = React.useState(false);

  async function openTimeline(item: StockItem) {
    setTimelineProduct(item);
    setTimelineLoading(true);
    setTimeline([]);
    try {
      const res = await fetch(`/api/inventory/movements?productId=${item.product.id}&pageSize=30`);
      const d = await res.json();
      setTimeline(d.movements ?? []);
    } catch {
      setTimeline([]);
    } finally {
      setTimelineLoading(false);
    }
  }

  // Transfer modal
  const [transferOpen, setTransferOpen] = React.useState(false);
  const [transferFrom, setTransferFrom] = React.useState("");
  const [transferTo, setTransferTo] = React.useState("");
  const [transferProductId, setTransferProductId] = React.useState("");
  const [transferSearch, setTransferSearch] = React.useState("");
  const [transferResults, setTransferResults] = React.useState<TransferProduct[]>([]);
  const [selectedTransferProduct, setSelectedTransferProduct] = React.useState<TransferProduct | null>(null);
  const [transferQty, setTransferQty] = React.useState("");
  const [transferNotes, setTransferNotes] = React.useState("");
  const [transfering, setTransfering] = React.useState(false);
  const [warehouses, setWarehouses] = React.useState<Array<{ id: string; name: string; code: string }>>([]);

  // Warehouse context
  const { selectedWarehouseId } = useWarehouseStore();

  // Debounce the search box so typing doesn't fire a fetch per keystroke.
  React.useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Fetch data based on active tab
  React.useEffect(() => {
    setLoading(true);
    setLoadError(false);
    if (activeTab === "stock") {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (lowStockOnly) params.set("lowStock", "true");
      if (selectedWarehouseId) params.set("warehouseId", selectedWarehouseId);
      // Load the WHOLE filtered scope, not just page 1. This tab has no pager,
      // so paging it silently capped the table, the "N results" counter and
      // every export (CSV / Excel / printed valuation) at 50 rows.
      params.set("all", "true");
      fetch(`/api/inventory?${params}`)
        .then((r) => r.json())
        .then((d) => {
          setStockItems(d.items ?? []);
          if (d.summary) setStockSummary(d.summary);
        })
        .catch((e) => { console.error(e); setLoadError(true); })
        .finally(() => setLoading(false));
    } else if (activeTab === "movements") {
      const params = new URLSearchParams({ page: String(movementPage), pageSize: String(MOVEMENTS_PAGE_SIZE) });
      if (movementWarehouse) params.set("warehouseId", movementWarehouse);
      if (movementType) params.set("type", movementType);
      fetch(`/api/inventory/movements?${params}`)
        .then((r) => r.json())
        .then((d) => {
          setMovements(d.movements ?? []);
          setMovementsMeta({
            total: typeof d.total === "number" ? d.total : 0,
            totalPages: Math.max(1, typeof d.totalPages === "number" ? d.totalPages : 1),
          });
        })
        .catch((e) => { console.error(e); setLoadError(true); })
        .finally(() => setLoading(false));
    } else {
      fetch("/api/inventory/transfer")
        .then((r) => r.json())
        .then((d) => setTransfers(d.transfers ?? []))
        .catch((e) => { console.error(e); setLoadError(true); })
        .finally(() => setLoading(false));
    }
  }, [activeTab, search, lowStockOnly, selectedWarehouseId, refreshKey, movementPage, movementWarehouse, movementType]);

  // Fetch warehouses on mount
  React.useEffect(() => {
    fetch("/api/warehouses")
      .then((r) => r.json())
      .then((d) => {
        const whs = d.warehouses ?? [];
        setWarehouses(whs);
        if (whs.length > 0 && !transferFrom) {
          setTransferFrom(whs[0]!.id);
          setTransferTo(whs.length > 1 ? whs[1]!.id : whs[0]!.id);
        }
      })
      .catch(console.error);
    // Deliberately mount-only: re-running after the user picks a source
    // warehouse would stomp their selection back to the defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Transfer stock lookup — keeps the last-known available quantity for the
  // currently-selected product so the hint can refresh without a full re-fetch.
  const [transferHint, setTransferHint] = React.useState<string | null>(null);
  const [transferAvailable, setTransferAvailable] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!transferSearch.trim() || transferProductId) {
      setTransferResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        // Shared catalog endpoint (/api/products/lookup) — the same rows
        // and availability numbers POS shows, so transfers can only pick
        // live, active products (soft-deleted/archived ones are excluded
        // at the source, which the old /api/products?search path allowed).
        const params = new URLSearchParams({ q: transferSearch.trim(), limit: "8" });
        if (transferFrom) params.set("warehouseId", transferFrom);
        const res = await fetch(`/api/products/lookup?${params}`);
        const data = await res.json();
        setTransferResults(
          (data.products ?? []).map(
            (p: { id: string; name: string; sku: string; unit?: string; allowFractional?: boolean; available?: number }) => ({
              id: p.id,
              name: p.name,
              sku: p.sku,
              unit: p.unit,
              allowFractional: p.allowFractional,
              available: typeof p.available === "number" ? p.available : null,
            }),
          ),
        );
      } catch {
        setTransferResults([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [transferSearch, transferProductId, transferFrom]);

  // Refresh the available-stock hint whenever the selected product or the
  // source warehouse changes — one fetch per change, debounced by React.
  React.useEffect(() => {
    if (!transferProductId || !transferFrom) {
      setTransferHint(null);
      setTransferAvailable(null);
      return;
    }
    let cancelled = false;
    (async () => {
      // Prefer the availability the shared lookup endpoint already returned
      // for the source warehouse — one source, no extra fetch. Fall back to
      // a scoped inventory fetch only when the picker was cleared.
      const fromPicker = transferResults.find((p) => p.id === transferProductId)?.available;
      let qty: number | null = typeof fromPicker === "number" ? fromPicker : null;
      if (qty === null) {
        try {
          const params = new URLSearchParams({ ids: transferProductId, warehouseId: transferFrom, limit: "1" });
          const res = await fetch(`/api/products/lookup?${params}`);
          if (!res.ok) throw new Error("fetch");
          const data = await res.json();
          const row = (data.products ?? [])[0] as { available?: number } | undefined;
          qty = typeof row?.available === "number" ? row.available : 0;
        } catch {
          qty = 0;
        }
      }
      if (!cancelled) {
        const unit = transferResults.find((p) => p.id === transferProductId)?.unit;
        const fromName = warehouses.find((w) => w.id === transferFrom)?.name ?? "—";
        setTransferAvailable(qty);
        setTransferHint(`${t("inventory.available")} (${fromName}): ${trimNumber(qty ?? 0)}${unit ? ` ${unit}` : ""}`);
      }
    })();
    return () => { cancelled = true; };
  }, [transferProductId, transferFrom, warehouses, transferResults, t]);

  /** Keep from/to warehouses pointing at different locations. */
  function setFromWarehouse(id: string) {
    setTransferFrom(id);
    if (id === transferTo) {
      const other = warehouses.find((w) => w.id !== id);
      if (other) setTransferTo(other.id);
    }
  }
  function setToWarehouse(id: string) {
    setTransferTo(id);
    if (id === transferFrom) {
      const other = warehouses.find((w) => w.id !== id);
      if (other) setTransferFrom(other.id);
    }
  }
  function swapWarehouses() {
    setTransferFrom(transferTo);
    setTransferTo(transferFrom);
  }

  function pickTransferProduct(p: TransferProduct) {
    setTransferProductId(p.id);
    setTransferSearch(p.name);
    setSelectedTransferProduct(p);
  }
  function clearTransferProduct() {
    setTransferProductId("");
    setTransferSearch("");
    setSelectedTransferProduct(null);
    setTransferQty("");
  }

  /** Movement-tab filter setters — always reset to the first page. */
  function setMovementWarehouseFiltered(id: string) {
    setMovementWarehouse(id);
    setMovementPage(1);
  }
  function setMovementTypeFiltered(next: string) {
    setMovementType(next);
    setMovementPage(1);
  }
  function clearMovementFilters() {
    setMovementWarehouse("");
    setMovementType("");
    setMovementPage(1);
  }

  function openAdjust(item: StockItem | null) {
    setAdjustType("adjustment");
    setAdjustTarget(item);
    setAdjustQty("");
    setAdjustNotes("");
    setAdjustOpen(true);
  }

  // Stock adjustment
  async function handleAdjust() {
    if (!adjustTarget || !adjustValid) return;
    setAdjusting(true);
    try {
      const qty = adjustQtyNum;
      const res = await fetch("/api/inventory/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: adjustTarget.product.id,
          warehouseId: adjustTarget.warehouse.id,
          quantity: qty,
          type: adjustType,
          notes: adjustNotes || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(t("inventory.adjustFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      // Tell other terminals this product's stock moved (POS grid etc.)
      broadcastStockChange(adjustTarget.product.id, adjustTarget.warehouse.id, qty);
      setAdjustOpen(false);
      setAdjustTarget(null);
      setAdjustQty("");
      setAdjustNotes("");
      // Refresh
      setActiveTab("stock");
      setRefreshKey((k) => k + 1);
      toast.success(t("inventory.adjusted"), t("inventory.adjustedDesc"));
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setAdjusting(false);
    }
  }

  // Stock transfer
  async function handleTransfer() {
    if (!transferProductId || !transferQty || !transferFrom || !transferTo) return;
    setTransfering(true);
    try {
      const qty = parseFloat(transferQty);
      if (!Number.isFinite(qty) || qty <= 0) {
        toast.error(t("inventory.transferQtyInvalid"), undefined);
        setTransfering(false);
        return;
      }
      const res = await fetch("/api/inventory/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromWarehouseId: transferFrom,
          toWarehouseId: transferTo,
          items: [{ productId: transferProductId, quantity: qty }],
          notes: transferNotes || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(t("inventory.transferFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      // Notify other terminals: source warehouse lost qty, destination gained it
      broadcastStockChange(transferProductId, transferFrom, -qty);
      broadcastStockChange(transferProductId, transferTo, qty);
      setTransferOpen(false);
      clearTransferProduct();
      setTransferNotes("");
      setActiveTab("transfers");
      setRefreshKey((k) => k + 1);
      toast.success(t("inventory.transferCreated"), t("inventory.transferCreatedDesc"));
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setTransfering(false);
    }
  }

  // Stats
  // Scope-wide, from the server summary — these describe the warehouse scope
  // you are viewing, independent of the current page, search or filter.
  const { totalStockValue, totalRetailValue } = stockSummary;
  const potentialMargin = Math.max(0, totalRetailValue - totalStockValue);
  const marginPct = totalRetailValue > 0 ? Math.round((potentialMargin / totalRetailValue) * 100) : 0;
  const lowStockCount = stockSummary.lowStockCount;
  const outOfStockCount = stockSummary.outOfStockCount;
  /** The restock worklist the filter chip returns: low + out, counted once. */
  const restockCount = lowStockCount + outOfStockCount;

  // Elite shared export columns — one config drives CSV, Excel and the
  // printed A4 stock-valuation report. Qty columns carry raw `excel`
  // numbers so the workbook totals are real SUM formulas; the totals
  // label is unit-aware (mixed-unit lists get no quantity total).
  const qtyTotal = (pick: (i: StockItem) => number) => (rows: StockItem[]) => {
    const units = new Set(rows.map((r) => r.product.unit ?? "pcs"));
    if (units.size !== 1) return "";
    return lineQtyLabel(rows.reduce((s, r) => s + pick(r), 0), rows[0]?.product.unit);
  };

  const inventoryExportColumns: ExportColumn<StockItem>[] = [
    { header: "product", value: (i) => i.product.name, print: { width: "22%", strong: true } },
    { header: "sku", value: (i) => i.product.sku, print: { muted: true } },
    { header: "barcode", value: (i) => i.product.barcode ?? "", omitPrint: true },
    { header: "category", value: (i) => i.product.category?.name ?? "", print: { muted: true } },
    { header: "warehouse", value: (i) => i.warehouse.name },
    {
      header: "quantity",
      value: (i) => lineQtyLabel(i.quantity, i.product.unit),
      excel: (i) => i.quantity,
      excelStyle: "int",
      print: { label: "Qty", align: "right", total: qtyTotal((i) => i.quantity) },
    },
    {
      header: "available",
      value: (i) => lineQtyLabel(i.quantity - i.reservedQuantity, i.product.unit),
      excel: (i) => i.quantity - i.reservedQuantity,
      excelStyle: "int",
      print: { label: "Available", align: "right", muted: true, total: qtyTotal((i) => i.quantity - i.reservedQuantity) },
    },
    {
      header: "status",
      value: (i) =>
        i.isOutOfStock ? t("inventory.outOfStock") : i.isLowStock ? t("inventory.lowStock") : t("inventory.inStock"),
      print: { align: "center" },
    },
    {
      header: "stockValue",
      value: (i) => (i.stockValue / 100).toFixed(2),
      excelStyle: "money",
      print: { label: "Stock Value", align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.stockValue, 0)) },
    },
    {
      header: "retailValue",
      value: (i) => ((i.quantity * i.product.unitPrice) / 100).toFixed(2),
      excelStyle: "money",
      print: { label: "Retail Value", align: "right", total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.quantity * r.product.unitPrice, 0)) },
    },
    { header: "costPrice", value: (i) => (i.product.costPrice / 100).toFixed(2), excelStyle: "money", omitPrint: true },
    { header: "unitPrice", value: (i) => (i.product.unitPrice / 100).toFixed(2), excelStyle: "money", omitPrint: true },
  ];

  // Multi-sheet Excel: stock valuation + low-stock watchlist
  const exportInventoryExcel = () => {
    const stockCols = inventoryExportColumns.filter((c) => !c.omitExcel);
    const sheets: ExcelSheet[] = [
      {
        name: "Stock",
        headers: stockCols.map((c) => c.header),
        rows: stockItems.map((i) =>
          stockCols.map((c) => {
            const v = c.value(i);
            return c.excelStyle ? { v, style: c.excelStyle } : v;
          })
        ),
        totals: stockCols.map((c, idx) => {
          if (!c.print?.total) return idx === 0 ? { v: t("export.total"), style: "bold" as const } : null;
          if (c.excelStyle === "money" || c.excelStyle === "int") {
            return sumFormulaCell(idx, stockItems.length, c.excelStyle === "money" ? "money-bold" : "int-bold");
          }
          return { v: c.print.total(stockItems), style: "bold" as const };
        }),
      },
    ];
    const low = stockItems.filter((i) => i.isLowStock || i.isOutOfStock);
    if (low.length > 0) {
      sheets.push({
        // "Restock", not "Low Stock": this sheet holds low AND out-of-stock rows
        // (the `status` column tells them apart) — naming it Low Stock made it
        // look like it contradicted the Low Stock KPI, which excludes zeros.
        name: "Restock",
        headers: ["product", "sku", "warehouse", "quantity", "minLevel", "status"],
        rows: low.map((i) => [
          i.product.name,
          i.product.sku,
          i.warehouse.name,
          { v: i.quantity, style: "int" as const },
          { v: i.product.minStockLevel, style: "int" as const },
          i.isOutOfStock ? t("inventory.outOfStock") : t("inventory.lowStock"),
        ]),
      });
    }
    downloadExcel("inventory", sheets);
    toast.success(t("common.exportStarted"), `${stockItems.length} ${t("inventory.items")}`);
  };

  // A4 stock-valuation report via the shared print engine
  const printStockValuation = async () => {
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("inventory.stockLevels"),
        kicker: "Inventory Valuation",
        kpis: [
          { label: t("inventory.totalValue"), value: formatCurrency(totalStockValue), tone: "positive" },
          {
            label: t("inventory.potentialMargin"),
            value: formatCurrency(potentialMargin),
            tone: "positive",
            hint: t("inventory.potentialMarginHint").replace("{pct}", String(marginPct)),
          },
          { label: t("inventory.productsTracked"), value: String(stockItems.length) },
          { label: t("inventory.lowStockCount"), value: String(lowStockCount), tone: lowStockCount > 0 ? "warning" : "positive" },
          { label: t("inventory.outOfStockCount"), value: String(outOfStockCount), tone: outOfStockCount > 0 ? "negative" : "positive" },
        ],
        columns: inventoryExportColumns
          .filter((c) => !c.omitPrint)
          .map((c) => ({
            label: c.print?.label ?? c.header,
            align: c.print?.align,
            width: c.print?.width,
            strong: c.print?.strong,
            muted: c.print?.muted,
            value: (row: StockItem) => String(c.value(row) ?? ""),
            total: c.print?.total,
          })),
        rows: stockItems,
        totalsLabel: t("inventory.totalValue"),
        footnote: t("inventory.description"),
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  // Stock status badge meta (shared rule with Products/POS/Dashboard).
  function statusMeta(item: StockItem): { variant: "danger" | "warning" | "success"; label: string } {
    if (item.stockStatus === "out" || item.isOutOfStock) return { variant: "danger", label: t("inventory.outOfStock") };
    if (item.stockStatus === "low" || item.isLowStock) return { variant: "warning", label: t("inventory.lowStock") };
    return { variant: "success", label: t("inventory.inStock") };
  }

  /** Fill % + color for the on-hand vs-min level bar (null hides the bar). */
  function stockBar(item: StockItem): { pct: number; tone: string } | null {
    const min = item.product.minStockLevel;
    if (min <= 0) return null;
    const raw = item.quantity <= 0 ? 0 : Math.min(100, (item.quantity / min) * 100);
    const pct = item.quantity > 0 ? Math.max(6, raw) : raw;
    const out = item.stockStatus === "out" || item.isOutOfStock;
    const low = !out && (item.stockStatus === "low" || item.isLowStock);
    return { pct, tone: out ? "qty-bar-out" : low ? "qty-bar-low" : "qty-bar-ok" };
  }

  const hasFilters = Boolean(search) || lowStockOnly;

  const tabs: Array<{ id: Tab; label: string; icon: string; count: number }> = [
    { id: "stock", label: t("inventory.stockLevels"), icon: P.box, count: stockItems.length },
    { id: "movements", label: t("inventory.movements"), icon: P.arrowPath, count: movementsMeta.total },
    { id: "transfers", label: t("inventory.transfers"), icon: P.swap, count: transfers.length },
  ];

  const stockEmpty = (
    <EmptyState
      bare
      icon={<Icon path={hasFilters ? P.search : P.box} />}
      title={hasFilters ? t("inventory.noResults") : t("inventory.noStockData")}
      description={hasFilters ? t("inventory.noResultsDesc") : undefined}
      action={
        hasFilters ? (
          <button type="button" className="clear-filters-btn" onClick={() => { setSearchInput(""); setLowStockOnly(false); }}>
            <Icon path={P.x} className="h-3 w-3" />
            {t("common.clearFilters")}
          </button>
        ) : undefined
      }
    />
  );

  const errorNode = (
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
        <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
          {t("common.retry")}
        </Button>
      }
    />
  );

  const movementFiltersActive = Boolean(movementWarehouse || movementType);
  const movementsEmpty = (
    <EmptyState
      bare
      icon={<Icon path={movementFiltersActive ? P.search : P.arrowPath} />}
      title={movementFiltersActive ? t("inventory.noResults") : t("inventory.noMovements")}
      description={movementFiltersActive ? t("inventory.noResultsDesc") : undefined}
      action={
        movementFiltersActive ? (
          <button type="button" className="clear-filters-btn" onClick={clearMovementFilters}>
            <Icon path={P.x} className="h-3 w-3" />
            {t("common.clearFilters")}
          </button>
        ) : undefined
      }
    />
  );

  // Max transferable amount (whole-unit products floor the decimals).
  const transferMax =
    transferAvailable === null || !selectedTransferProduct
      ? null
      : isLoose(selectedTransferProduct.unit, selectedTransferProduct.allowFractional)
        ? transferAvailable
        : Math.floor(transferAvailable);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("inventory.title")}
        description={t("inventory.description")}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("inventory.title") },
        ]}
        actions={
          <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
            <ExportMenu<StockItem>
              fileStem="inventory"
              sheetName="Inventory"
              rows={stockItems}
              columns={inventoryExportColumns}
              customItems={[{ label: t("export.excelSheets"), icon: "excel", onSelect: exportInventoryExcel }]}
              printKicker="Inventory Valuation"
              printTotalsLabel={t("inventory.totalValue")}
              onPrint={printStockValuation}
              disabled={stockItems.length === 0}
            />
            <Button
              variant="secondary"
              onClick={() => setTransferOpen(true)}
              title={t("inventory.newTransfer")}
              aria-label={t("inventory.newTransfer")}
            >
              <Icon path={P.swap} className="h-4 w-4" />
              <span className="hidden sm:inline">{t("inventory.newTransfer")}</span>
            </Button>
            <Button onClick={() => openAdjust(null)} title={t("inventory.adjustStock")} aria-label={t("inventory.adjustStock")}>
              <Icon path={P.plus} className="h-4 w-4" />
              <span className="hidden sm:inline">{t("inventory.adjustStock")}</span>
            </Button>
          </div>
        }
      />

      {/* Stats */}
      {loading && activeTab === "stock" && stockItems.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <div className="space-y-2">
                  <div className="skeleton h-4 w-20 rounded" />
                  <div className="skeleton h-8 w-28 rounded" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard
            label={t("inventory.totalValue")}
            value={formatCurrency(totalStockValue)}
            icon="cash"
            tone="brand"
          />          <StatCard
            label={t("inventory.potentialMargin")}
            value={formatCurrency(potentialMargin)}
            icon="chart"
            tone="success"
            sub={t("inventory.potentialMarginHint").replace("{pct}", String(marginPct))}
            bar={[
              { pct: 100 - marginPct, className: "bg-neu-sunken", label: t("inventory.marginBarCost") },
              { pct: marginPct, className: "bg-neu-solid-green", label: t("inventory.marginBarMargin") },
            ]}
            barLabel={t("inventory.marginBarLabel").replace("{pct}", String(marginPct))}
          />
          <StatCard
            label={t("inventory.productsTracked")}
            value={String(stockSummary.stockRows)}
            icon="box"
            tone="info"
          />
          <StatCard
            label={t("inventory.lowStockCount")}
            value={String(lowStockCount)}
            icon="alert"
            tone={lowStockCount > 0 ? "warning" : "success"}
          />
          <StatCard
            label={t("inventory.outOfStockCount")}
            value={String(outOfStockCount)}
            icon="xcircle"
            tone={outOfStockCount > 0 ? "danger" : "success"}
          />
        </div>
      )}

      {/* Tabs */}
      <div className="inventory-tabs" role="tablist" aria-label={t("inventory.title")}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn("inventory-tab", activeTab === tab.id && "active")}
          >
            <Icon path={tab.icon} className="h-4 w-4" />
            {tab.label}
            {tab.count > 0 && <span className="inventory-tab-count">{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* Search bar for stock tab */}
      {activeTab === "stock" && (
        <div className="flex flex-wrap items-center gap-2.5">
          <Input
            placeholder={t("products.search")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            leftIcon={<Icon path={P.search} className="h-4 w-4" />}
            wrapperClassName="w-full sm:w-64"
          />
          <button
            type="button"
            className={cn("filter-chip", lowStockOnly && "filter-chip-active")}
            onClick={() => setLowStockOnly((v) => !v)}
            aria-pressed={lowStockOnly}
          >
            <Icon path={P.alert} className="h-3.5 w-3.5" />
            {/* Card + chip label the WORKLIST (low + out), because that is what
                the filter returns and what the badge counts — the chip used to
                read "Low stock only" and badge the low-only KPI while listing
                out-of-stock rows too. */}
            {t("inventory.restockOnly")}
            {restockCount > 0 && <span className="filter-chip-count">{restockCount}</span>}
          </button>
          {!loading && (
            <span className="ms-auto text-xs tabular-nums text-neu-faint">
              {stockItems.length} {t("common.results")}
            </span>
          )}
          {hasFilters && (
            <button
              type="button"
              className="clear-filters-btn"
              onClick={() => { setSearchInput(""); setLowStockOnly(false); }}
            >
              <Icon path={P.x} className="h-3 w-3" />
              {t("common.clearFilters")}
            </button>
          )}
        </div>
      )}

      {/* Stock Levels — desktop table */}
      {activeTab === "stock" && (
        <Card className="hidden md:block">
          <CardContent className="table-scroll-lg p-0">
            <table className={cn("inventory-table", "inventory-table-wide")}>
              <thead>
                <tr>
                  <SortableTh bare label={t("inventory.product")} className={TH} active={stockSort.startsWith("product.")} order={stockSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleStockSort("product")} />
                  <SortableTh bare label={t("inventory.warehouse")} className={TH} active={stockSort.startsWith("warehouse.")} order={stockSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleStockSort("warehouse")} />
                  <SortableTh bare label={t("inventory.stock")} className={cn(TH, "inv-th-end")} align="end" active={stockSort.startsWith("stock.")} order={stockSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleStockSort("stock")} />
                  <SortableTh bare label={t("inventory.available")} className={cn(TH, "inv-th-end")} align="end" active={stockSort.startsWith("available.")} order={stockSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleStockSort("available")} />
                  <SortableTh bare label={t("inventory.value")} className={cn(TH, "inv-th-end")} align="end" active={stockSort.startsWith("value.")} order={stockSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleStockSort("value")} />
                  <th className={cn(TH, "inv-th-center")}>{t("inventory.status")}</th>
                  <th className={cn(TH, "inv-th-end")}>{t("inventory.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <TableSkeleton rows={6} />
                ) : loadError ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-0">{errorNode}</td>
                  </tr>
                ) : stockItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-0">{stockEmpty}</td>
                  </tr>
                ) : (
                  sortedStockItems.map((item) => {
                    const bar = stockBar(item);
                    const meta = statusMeta(item);
                    return (
                      <tr key={item.id} className="products-table-row">
                        <td className="inv-td">
                          <p className="max-w-[240px] truncate text-sm font-medium text-neu-primary" title={item.product.name}>
                            {item.product.name}
                          </p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-neu-faint">
                            <span className="max-w-[140px] truncate">{item.product.category.name}</span>
                            <span aria-hidden>·</span>
                            <span className="font-mono">{item.product.sku}</span>
                          </p>
                        </td>
                        <td className="inv-td">
                          <span className="text-sm text-neu-muted">{item.warehouse.name}</span>
                        </td>
                        <td className="inv-td text-end">
                          <div className="flex flex-col items-end gap-1.5">
                            <span className={cn("text-sm font-semibold tabular-nums", meta.variant === "danger" ? "text-neu-ink-red" : "text-neu-primary")}>
                              {trimNumber(item.quantity)}
                              <span className="text-xs font-normal text-neu-faint">{unitSuffix(item.product.unit)}</span>
                            </span>
                            {bar && (
                              <>
                                <span className="qty-bar w-20" aria-hidden>
                                  <span className={cn("qty-bar-fill", bar.tone)} style={{ width: `${bar.pct}%` }} />
                                </span>
                                <span className="text-[10px] tabular-nums text-neu-faint">
                                  {t("inventory.min")} {trimNumber(item.product.minStockLevel)}
                                </span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="inv-td text-end">
                          <span className="text-sm font-medium tabular-nums text-neu-primary">
                            {trimNumber(item.available)}
                            <span className="text-xs font-normal text-neu-faint">{unitSuffix(item.product.unit)}</span>
                          </span>
                        </td>
                        <td className="inv-td text-end">
                          <span className="text-sm font-medium tabular-nums text-neu-muted">
                            {formatCurrency(item.stockValue)}
                          </span>
                        </td>
                        <td className="inv-td text-center">
                          <Badge variant={meta.variant} size="sm" dot>{meta.label}</Badge>
                        </td>
                        <td className="inv-td text-end">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              title={t("inventory.historyTitle")}
                              aria-label={t("inventory.historyTitle")}
                              onClick={() => openTimeline(item)}
                            >
                              <Icon path={P.clock} className="h-4 w-4" />
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => openAdjust(item)}>
                              {t("inventory.adjust")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Stock Levels — mobile cards */}
      {activeTab === "stock" && (
        <div className="space-y-3 md:hidden">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-40 rounded-xl" />
            ))
          ) : loadError ? (
            <Card><CardContent className="p-0">{errorNode}</CardContent></Card>
          ) : stockItems.length === 0 ? (
            <Card><CardContent className="p-0">{stockEmpty}</CardContent></Card>
          ) : (
            stockItems.map((item) => {
              const meta = statusMeta(item);
              return (
                <div key={item.id} className="inventory-transfer-card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-neu-primary">{item.product.name}</p>
                      <p className="mt-0.5 truncate text-xs text-neu-faint">
                        {item.warehouse.name} · <span className="font-mono">{item.product.sku}</span>
                      </p>
                    </div>
                    <Badge variant={meta.variant} size="sm" dot className="shrink-0">{meta.label}</Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-neu-sunken p-2.5">
                    <div className="text-center">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-neu-faint">{t("inventory.stock")}</p>
                      <p className="mt-0.5 text-sm font-bold tabular-nums text-neu-primary">
                        {trimNumber(item.quantity)}
                        <span className="text-[10px] font-normal text-neu-faint">{unitSuffix(item.product.unit)}</span>
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-neu-faint">{t("inventory.available")}</p>
                      <p className="mt-0.5 text-sm font-bold tabular-nums text-neu-primary">
                        {trimNumber(item.available)}
                        <span className="text-[10px] font-normal text-neu-faint">{unitSuffix(item.product.unit)}</span>
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-neu-faint">{t("inventory.value")}</p>
                      <p className="mt-0.5 text-sm font-bold tabular-nums text-neu-primary">{formatCurrency(item.stockValue)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="flex-1"
                      onClick={() => openTimeline(item)}
                    >
                      <Icon path={P.clock} className="h-4 w-4" />
                      {t("inventory.historyTitle")}
                    </Button>
                    <Button type="button" size="sm" className="flex-1" onClick={() => openAdjust(item)}>
                      <Icon path={P.adjust} className="h-4 w-4" />
                      {t("inventory.adjust")}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Movements filter bar */}
      {activeTab === "movements" && (
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="w-full sm:w-48">
            <select
              className="inv-select"
              value={movementWarehouse}
              onChange={(e) => setMovementWarehouseFiltered(e.target.value)}
              aria-label={t("inventory.warehouse")}
            >
              <option value="">{t("common.all")} — {t("inventory.warehouse")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
              ))}
            </select>
          </div>
          <div className="w-full sm:w-44">
            <select
              className="inv-select"
              value={movementType}
              onChange={(e) => setMovementTypeFiltered(e.target.value)}
              aria-label={t("inventory.movementType")}
            >
              <option value="">{t("common.all")} — {t("inventory.movementType")}</option>
              {MOVEMENT_TYPES.map((type) => (
                <option key={type} value={type}>{t(`inventory.movement.${type}`)}</option>
              ))}
            </select>
          </div>
          {!loading && (
            <span className="ms-auto text-xs tabular-nums text-neu-faint">
              {movementsMeta.total} {t("common.results")}
            </span>
          )}
          {movementFiltersActive && (
            <button type="button" className="clear-filters-btn" onClick={clearMovementFilters}>
              <Icon path={P.x} className="h-3 w-3" />
              {t("common.clearFilters")}
            </button>
          )}
        </div>
      )}

      {/* Movements — desktop table */}
      {activeTab === "movements" && (
        <Card className="hidden md:block">
          <CardContent className="table-scroll-lg p-0">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th className={TH}>{t("orders.date")}</th>
                  <th className={TH}>{t("inventory.product")}</th>
                  <th className={TH}>{t("inventory.movementType")}</th>
                  <th className={cn(TH, "inv-th-end")}>{t("inventory.quantity")}</th>
                  <th className={TH}>{t("inventory.warehouse")}</th>
                  <th className={TH}>{t("inventory.by")}</th>
                  <th className={TH}>{t("inventory.notes")}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <TableSkeleton rows={5} />
                ) : loadError ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-0">{errorNode}</td>
                  </tr>
                ) : movements.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-0">{movementsEmpty}</td>
                  </tr>
                ) : (
                  movements.map((m) => {
                    const inQty = m.quantity > 0;
                    const label = t(`inventory.movement.${m.type}`);
                    return (
                      <tr key={m.id} className="products-table-row">
                        <td className="inv-td">
                          <p className="whitespace-nowrap text-xs font-medium tabular-nums text-neu-muted">
                            {fmtDate(m.createdAt)}
                          </p>
                          <p className="whitespace-nowrap text-[10px] tabular-nums text-neu-faint">
                            {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </td>
                        <td className="inv-td">
                          <p className="max-w-[200px] truncate text-sm font-medium text-neu-primary" title={m.product.name}>
                            {m.product.name}
                          </p>
                          <p className="font-mono text-xs text-neu-faint">{m.product.sku}</p>
                        </td>
                        <td className="inv-td">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
                              inQty
                                ? "bg-neu-wash-green text-neu-ink-green"
                                : "bg-neu-wash-red text-neu-ink-red",
                            )}
                          >
                            <Icon path={MOVEMENT_ICON[m.type] ?? P.minusCircle} className="h-3.5 w-3.5" />
                            {label === `inventory.movement.${m.type}` ? m.type : label}
                          </span>
                        </td>
                        <td className={cn(
                          "inv-td whitespace-nowrap text-end text-sm font-semibold tabular-nums",
                          inQty ? "text-neu-ink-green" : "text-neu-ink-red",
                        )}>
                          {inQty ? "+" : m.quantity < 0 ? "−" : ""}
                          {lineQtyLabel(Math.abs(m.quantity), m.product.unit)}
                        </td>
                        <td className="inv-td">
                          <span className="whitespace-nowrap text-sm text-neu-muted">{m.warehouse.name}</span>
                        </td>
                        <td className="inv-td">
                          <span className="whitespace-nowrap text-sm text-neu-muted">{m.performedBy.name}</span>
                        </td>
                        <td className="inv-td">
                          <span
                            className="block max-w-[180px] truncate text-xs text-neu-faint"
                            title={m.notes ?? undefined}
                          >
                            {m.notes ?? "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Movements — mobile cards */}
      {activeTab === "movements" && (
        <div className="space-y-3 md:hidden">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-28 rounded-xl" />
            ))
          ) : loadError ? (
            <Card><CardContent className="p-0">{errorNode}</CardContent></Card>
          ) : movements.length === 0 ? (
            <Card><CardContent className="p-0">{movementsEmpty}</CardContent></Card>
          ) : (
            movements.map((m) => {
              const inQty = m.quantity > 0;
              const label = t(`inventory.movement.${m.type}`);
              return (
                <div key={m.id} className="inventory-transfer-card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-neu-primary">{m.product.name}</p>
                      <p className="font-mono text-xs text-neu-faint">{m.product.sku}</p>
                    </div>
                    <span className={cn(
                      "shrink-0 text-sm font-bold tabular-nums",
                      inQty ? "text-neu-ink-green" : "text-neu-ink-red",
                    )}>
                      {inQty ? "+" : m.quantity < 0 ? "−" : ""}
                      {lineQtyLabel(Math.abs(m.quantity), m.product.unit)}
                    </span>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neu-faint">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium",
                        inQty
                          ? "bg-neu-wash-green text-neu-ink-green"
                          : "bg-neu-wash-red text-neu-ink-red",
                      )}
                    >
                      <Icon path={MOVEMENT_ICON[m.type] ?? P.minusCircle} className="h-3 w-3" />
                      {label === `inventory.movement.${m.type}` ? m.type : label}
                    </span>
                    <span className="tabular-nums">{fmtDateTime(m.createdAt)}</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-neu-faint">
                    <span className="truncate">{m.warehouse.name} · {m.performedBy.name}</span>
                    {m.notes && (
                      <span className="max-w-[40%] truncate" title={m.notes}>{m.notes}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Movements pagination */}
      {activeTab === "movements" && !loading && movementsMeta.total > 0 && (
        <div className="pagination-footer">
          <p className="pagination-info hidden sm:block">
            {t("common.showing")} {(movementPage - 1) * MOVEMENTS_PAGE_SIZE + 1}–
            {Math.min(movementPage * MOVEMENTS_PAGE_SIZE, movementsMeta.total)} {t("common.of")}{" "}
            {movementsMeta.total}
          </p>
          <div className="pagination-controls">
            <Button
              variant="secondary"
              size="icon-sm"
              disabled={movementPage <= 1}
              onClick={() => setMovementPage((p) => Math.max(1, p - 1))}
              aria-label={t("common.previous")}
            >
              <Icon path={P.chevronLeft} className="h-4 w-4 rtl:-scale-x-100" />
            </Button>
            <span className="pagination-page whitespace-nowrap tabular-nums">
              {t("common.page")} {movementPage} {t("common.of")} {movementsMeta.totalPages}
            </span>
            <Button
              variant="secondary"
              size="icon-sm"
              disabled={movementPage >= movementsMeta.totalPages}
              onClick={() => setMovementPage((p) => p + 1)}
              aria-label={t("common.next")}
            >
              <Icon path={P.chevronRight} className="h-4 w-4 rtl:-scale-x-100" />
            </Button>
          </div>
        </div>
      )}

      {/* Transfers */}
      {activeTab === "transfers" && (
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-3 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="skeleton h-[72px] w-full rounded-xl" />
                ))}
              </div>
            ) : loadError ? (
              errorNode
            ) : transfers.length === 0 ? (
              <EmptyState
                bare
                icon={<Icon path={P.swap} />}
                title={t("inventory.noTransfers")}
                description={t("inventory.description")}
                action={
                  <Button size="sm" onClick={() => setTransferOpen(true)}>
                    <Icon path={P.plus} className="h-4 w-4" />
                    {t("inventory.newTransfer")}
                  </Button>
                }
              />
            ) : (
              <div className="divide-y divide-neu-hairline">
                {transfers.map((tr) => {
                  const statusLabel = t(`inventory.transferStatus.${tr.status}`);
                  return (
                    <div
                      key={tr.id}
                      className="flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-neu-sunken/70 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                          <span className="inv-route-node" title={tr.fromWarehouse.name}>
                            {tr.fromWarehouse.name}
                          </span>
                          <Icon path={P.arrowRight} className="h-4 w-4 shrink-0 text-neu-faint rtl:-scale-x-100" />
                          <span className="inv-route-node" title={tr.toWarehouse.name}>
                            {tr.toWarehouse.name}
                          </span>
                          <Badge
                            variant={tr.status === "received" ? "success" : tr.status === "cancelled" ? "danger" : "warning"}
                            size="sm"
                            dot
                          >
                            {statusLabel === `inventory.transferStatus.${tr.status}` ? tr.status : statusLabel}
                          </Badge>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neu-faint">
                          <span className="tabular-nums">{tr.items.length} {t("inventory.items")}</span>
                          <span className="tabular-nums">{fmtDate(tr.createdAt)}</span>
                          <span>{t("inventory.by")} {tr.createdBy.name}</span>
                          {tr.notes && (
                            <span className="max-w-[220px] truncate text-neu-faint" title={tr.notes}>
                              {tr.notes}
                            </span>
                          )}
                        </div>
                      </div>
                      <Icon
                        path={TRANSFER_STATUS_ICON[tr.status] ?? P.minusCircle}
                        className="hidden h-5 w-5 shrink-0 text-neu-faint sm:block"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ═══ PRODUCT MOVEMENT TIMELINE DRAWER ═══ */}
      <Dialog open={Boolean(timelineProduct)} onOpenChange={(o) => !o && setTimelineProduct(null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("inventory.historyTitle")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {timelineProduct && (
              <>
                <div className="rounded-xl border border-neu-hairline bg-neu-sunken p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-neu-primary">{timelineProduct.product.name}</p>
                      <p className="truncate font-mono text-xs text-neu-faint">{timelineProduct.product.sku}</p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-neu-faint">
                        {t("inventory.currentStock")}
                      </p>
                      <p className="text-sm font-bold tabular-nums text-neu-primary">
                        {trimNumber(timelineProduct.quantity)}
                        <span className="text-xs font-normal text-neu-faint">{unitSuffix(timelineProduct.product.unit)}</span>
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-neu-faint">
                    <Icon path={P.box} className="h-3.5 w-3.5" />
                    {timelineProduct.warehouse.name}
                  </p>
                </div>
                <div className="mt-5">
                  {timelineLoading ? (
                    <div className="space-y-3">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <div className="skeleton h-7 w-7 rounded-full" />
                          <div className="skeleton h-4 flex-1 rounded" />
                        </div>
                      ))}
                    </div>
                  ) : timeline.length === 0 ? (
                    <EmptyState bare icon={<Icon path={P.arrowPath} />} title={t("inventory.noMovements")} />
                  ) : (
                    <div className="relative flex flex-col border-s-2 border-neu-hairline ps-5">
                      {timeline.map((m) => {
                        const inQty = m.quantity > 0;
                        const label = t(`inventory.movement.${m.type}`);
                        return (
                          <div key={m.id} className="relative pb-4 last:pb-0">
                            <span
                              className={cn(
                                "absolute -start-[26px] top-1 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white dark:ring-neu-hairline",
                                inQty ? "bg-neu-solid-green" : m.quantity < 0 ? "bg-neu-solid-red" : "bg-neu-muted",
                              )}
                              aria-hidden
                            />
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span className={cn(
                                    "text-sm font-semibold tabular-nums",
                                    inQty ? "text-neu-ink-green" : m.quantity < 0 ? "text-neu-ink-red" : "text-neu-muted",
                                  )}>
                                    {inQty ? "+" : m.quantity < 0 ? "−" : ""}
                                    {trimNumber(Math.abs(m.quantity))}
                                    {unitSuffix(m.product.unit)}
                                  </span>
                                  <span className="inline-flex items-center gap-1 text-xs font-medium text-neu-faint">
                                    <Icon path={MOVEMENT_ICON[m.type] ?? P.minusCircle} className="h-3 w-3" />
                                    {label === `inventory.movement.${m.type}` ? m.type : label}
                                  </span>
                                </p>
                                {m.notes && (
                                  <p className="mt-0.5 truncate text-xs text-neu-faint" title={m.notes}>{m.notes}</p>
                                )}
                              </div>
                              <div className="shrink-0 text-end">
                                <p className="text-xs tabular-nums text-neu-faint">{fmtDate(m.createdAt)}</p>
                                <p className="text-[10px] tabular-nums text-neu-faint">
                                  {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                                </p>
                                <p className="text-[10px] text-neu-faint">{m.performedBy?.name}</p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setTimelineProduct(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ ADJUST STOCK MODAL ═══ */}
      <Dialog open={adjustOpen} onOpenChange={(o) => { if (!o) { setAdjustOpen(false); setAdjustTarget(null); } }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("inventory.adjustStock")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {adjustTarget && (
              <div className="rounded-xl border border-neu-accent-line bg-neu-accent-wash p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-neu-accent-ink-strong">
                      {adjustTarget.product.name}
                    </p>
                    <p className="font-mono text-xs text-neu-accent-ink">{adjustTarget.product.sku}</p>
                  </div>
                  {adjustTarget.product.unit && (
                    <span className="shrink-0 rounded-md bg-neu-accent-wash px-1.5 py-0.5 text-[10px] font-medium text-neu-accent-ink-strong">
                      {adjustTarget.product.unit}
                    </span>
                  )}
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-2 text-sm">
                  <span className="text-neu-muted">{t("inventory.currentStock")}</span>
                  <span className="font-semibold tabular-nums text-neu-primary">
                    {trimNumber(adjustTarget.quantity)}
                    <span className="text-xs font-normal text-neu-faint">{unitSuffix(adjustTarget.product.unit)}</span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-neu-faint">
                  {t("inventory.warehouse")}: {adjustTarget.warehouse.name} ({adjustTarget.warehouse.code})
                </p>
              </div>
            )}
            <div>
              <label htmlFor="adjust-type" className="mb-1.5 block text-sm font-medium text-neu-primary">
                {t("inventory.adjustmentType")}
              </label>
              <select
                id="adjust-type"
                className="inv-select"
                value={adjustType}
                onChange={(e) => setAdjustType(e.target.value)}
              >
                <option value="adjustment">{t("inventory.adjustmentTypes.adjustment")}</option>
                <option value="count">{t("inventory.adjustmentTypes.count")}</option>
                <option value="damaged">{t("inventory.adjustmentTypes.damaged")}</option>
                <option value="expired">{t("inventory.adjustmentTypes.expired")}</option>
                <option value="return">{t("inventory.adjustmentTypes.return")}</option>
              </select>
            </div>
            <Input
              label={`${t("inventory.quantity")}${adjustTarget ? ` (${adjustTarget.product.unit ?? "pcs"})` : ""}`}
              type="number"
              step={adjustTarget && isLoose(adjustTarget.product.unit, adjustTarget.product.allowFractional) ? "any" : "1"}
              placeholder={t("inventory.adjustQtyPlaceholder")}
              value={adjustQty}
              onChange={(e) => setAdjustQty(e.target.value)}
              autoFocus
            />
            {adjustTarget && !isLoose(adjustTarget.product.unit, adjustTarget.product.allowFractional) && (
              <div className="flex flex-wrap gap-1.5">
                {[-10, -1, 1, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="quick-conv-chip tabular-nums"
                    onClick={() => setAdjustQty(String((parseFloat(adjustQty) || 0) + n))}
                  >
                    {n > 0 ? `+${n}` : `${n}`}
                  </button>
                ))}
              </div>
            )}
            {adjustTarget && adjustValid && (
              <div className="flex items-center justify-between rounded-lg bg-neu-sunken px-3 py-2">
                <span className="text-xs text-neu-faint">{t("inventory.currentStock")} →</span>
                <span className={cn(
                  "text-sm font-semibold tabular-nums",
                  adjustTarget.quantity + adjustQtyNum < 0
                    ? "text-neu-ink-red"
                    : "text-neu-primary",
                )}>
                  {trimNumber(adjustTarget.quantity)} → {trimNumber(adjustTarget.quantity + adjustQtyNum)}
                  <span className="text-xs font-normal text-neu-faint">{unitSuffix(adjustTarget.product.unit)}</span>
                </span>
              </div>
            )}
            <p className="text-xs text-neu-faint">{t("inventory.adjustQtyHint")}</p>
            <Input
              label={`${t("inventory.notes")} (${t("common.optional")})`}
              placeholder={t("inventory.adjustReasonPlaceholder")}
              value={adjustNotes}
              onChange={(e) => setAdjustNotes(e.target.value)}
            />
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => { setAdjustOpen(false); setAdjustTarget(null); }}>
              {t("common.cancel")}
            </Button>
            <Button loading={adjusting} disabled={!adjustValid} onClick={handleAdjust}>
              {t("inventory.applyAdjustment")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ TRANSFER MODAL ═══ */}
      <Dialog open={transferOpen} onOpenChange={(o) => { if (!o) setTransferOpen(false); }}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("inventory.newTransfer")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {/* Route: from → swap → to */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <label htmlFor="transfer-from" className="mb-1.5 block text-sm font-medium text-neu-primary">
                  {t("inventory.fromWarehouse")}
                </label>
                <select
                  id="transfer-from"
                  className="inv-select"
                  value={transferFrom}
                  onChange={(e) => setFromWarehouse(e.target.value)}
                  disabled={warehouses.length < 2}
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
                  ))}
                </select>
                {warehouses.length < 2 && (
                  <p className="mt-1 text-xs text-neu-ink-red">{t("inventory.needTwoWarehouses")}</p>
                )}
              </div>
              <button
                type="button"
                onClick={swapWarehouses}
                disabled={warehouses.length < 2}
                title={t("inventory.swap")}
                aria-label={t("inventory.swap")}
                className="chip-btn mx-auto shrink-0 sm:mt-[30px]"
              >
                <Icon path={P.swap} className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <label htmlFor="transfer-to" className="mb-1.5 block text-sm font-medium text-neu-primary">
                  {t("inventory.toWarehouse")}
                </label>
                <select
                  id="transfer-to"
                  className="inv-select"
                  value={transferTo}
                  onChange={(e) => setToWarehouse(e.target.value)}
                  disabled={warehouses.length < 2}
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Product picker */}
            <div className="relative">
              <label htmlFor="transfer-product" className="mb-1.5 block text-sm font-medium text-neu-primary">
                {t("inventory.product")} *
              </label>
              <div className="relative">
                <input
                  id="transfer-product"
                  type="text"
                  value={transferSearch}
                  onChange={(e) => {
                    setTransferSearch(e.target.value);
                    if (transferProductId) {
                      setTransferProductId("");
                      setSelectedTransferProduct(null);
                    }
                  }}
                  placeholder={t("inventory.transferProductPlaceholder")}
                  autoComplete="off"
                  className="h-10 w-full rounded-lg border border-neu-hairline bg-neu-bg pe-9 ps-3 text-sm text-neu-primary placeholder:text-neu-faint disabled:cursor-not-allowed disabled:opacity-50 neu-focus"
                />
                <Icon
                  path={P.search}
                  className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neu-faint"
                />
              </div>
              {transferSearch.trim() && !selectedTransferProduct && transferResults.length > 0 && (
                <div
                  className="neu-popover absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-xl border border-neu-hairline bg-neu-bg"
                  role="listbox"
                >
                  {transferResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => pickTransferProduct(p)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-start transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-neu-sunken"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-neu-primary">{p.name}</p>
                        <p className="truncate font-mono text-xs text-neu-faint">{p.sku}</p>
                      </div>
                      {typeof p.available === "number" && (
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                            p.available <= 0
                              ? "bg-neu-wash-red text-neu-ink-red"
                              : "bg-neu-sunken text-neu-muted",
                          )}
                        >
                          {trimNumber(p.available)}{unitSuffix(p.unit)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {selectedTransferProduct && (
                <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-neu-accent-line bg-neu-accent-wash p-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neu-accent-wash text-neu-accent-ink-strong">
                    <Icon path={P.box} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neu-accent-ink-strong">
                      {selectedTransferProduct.name}
                    </p>
                    <p className="truncate font-mono text-xs text-neu-accent-ink">
                      {selectedTransferProduct.sku}
                    </p>
                  </div>
                  {selectedTransferProduct.unit && !WHOLE_UNITS.has(selectedTransferProduct.unit) && (
                    <span className="shrink-0 rounded-md bg-neu-accent-wash px-1.5 py-0.5 text-[10px] font-medium text-neu-accent-ink-strong">
                      {selectedTransferProduct.unit}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={clearTransferProduct}
                    className="shrink-0 rounded-md p-1 text-neu-accent-ink transition-colors hover:bg-neu-accent-wash hover:text-neu-accent-ink-strong"
                    aria-label={t("common.clear")}
                  >
                    <Icon path={P.x} className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            {/* Quantity + Max */}
            <div>
              <Input
                label={t("inventory.quantity") + (selectedTransferProduct?.unit ? ` (${selectedTransferProduct.unit})` : "")}
                type="number"
                min={0.001}
                step={
                  selectedTransferProduct &&
                  isLoose(selectedTransferProduct.unit, selectedTransferProduct.allowFractional)
                    ? "any"
                    : "1"
                }
                placeholder={t("inventory.transferQtyPlaceholder")}
                value={transferQty}
                onChange={(e) => setTransferQty(e.target.value)}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className="truncate text-xs text-neu-faint">{transferHint ?? ""}</p>
                {selectedTransferProduct && transferMax !== null && transferMax > 0 && (
                  <button
                    type="button"
                    className="quick-conv-chip shrink-0 font-semibold text-neu-accent-ink"
                    onClick={() => setTransferQty(trimNumber(transferMax))}
                  >
                    {t("inventory.max")} ({trimNumber(transferMax)})
                  </button>
                )}
              </div>
            </div>

            <Input
              label={`${t("inventory.notes")} (${t("common.optional")})`}
              placeholder={t("inventory.transferReasonPlaceholder")}
              value={transferNotes}
              onChange={(e) => setTransferNotes(e.target.value)}
            />
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setTransferOpen(false)}>{t("common.cancel")}</Button>
            <Button
              loading={transfering}
              disabled={!transferProductId || !transferQty || transferFrom === transferTo}
              onClick={handleTransfer}
            >
              {t("inventory.createTransfer")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
