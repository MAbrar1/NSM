"use client";

import * as React from "react";
import { centsToMajorString } from "@/lib/money/money";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SortableTh } from "@/components/ui/sortable-th";
import { useTableRowNav } from "@/hooks/use-table-row-nav";
import { toast } from "@/stores/toast-store";
import { formatCurrency } from "@/lib/utils";
import { readApiError } from "@/lib/api/api-error";
import { displayMajorToBaseCents, baseCentsToDisplayMajorStr } from "@/lib/money/currency-core";
import { ensureRates, peekRates } from "@/lib/money/currency";
import { WHOLE_UNITS } from "@/lib/products/units";
import { downloadCsv } from "@/lib/files/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { ImportResultDialog, type ImportSummary } from "@/components/import/import-result-dialog";
import { fetchReportSettings, printReport } from "@/lib/print/print-report";
import { previewPurchaseOrder, printPurchaseOrder } from "@/lib/print/print-purchase-order";
import { useHardwareScanner } from "@/hooks/use-hardware-scanner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* ═══════════════════════════════════════════════════════════════
   PURCHASE ORDERS PAGE
   Full PO management with create, status flow, and receive.
   ═══════════════════════════════════════════════════════════════ */

interface POItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  receivedQty: number;
  unitCost: number;
  taxRate: number;
  total: number;
  product?: { unit?: string; allowFractional?: boolean; barcode?: string | null } | null;
}

interface PurchaseOrder {
  id: string;
  orderNumber: string;
  status: string;
  subtotal: number;
  taxAmount: number;
  shippingCost: number;
  total: number;
  notes: string | null;
  expectedDate: string | null;
  createdAt: string;
  supplier: { id: string; name: string };
  warehouse: { id: string; name: string };
  createdBy: { id: string; name: string };
  items: POItem[];
  _count: { items: number };
}

interface Supplier { id: string; name: string; }
interface Warehouse { id: string; name: string; code: string; }
interface Product { id: string; name: string; sku: string; unitPrice: number; costPrice: number; unit?: string; allowFractional?: boolean; }

interface POItemForm {
  productId: string;
  productName: string;
  sku: string;
  unit?: string;
  allowFractional?: boolean;
  quantity: number;
  unitCost: number;
  taxRate: number;
}

/** Is this PO line ordered in a loose (weight/volume) unit? */
function isLooseLine(item: { unit?: string; allowFractional?: boolean }): boolean {
  return Boolean(item.allowFractional) || (Boolean(item.unit) && !WHOLE_UNITS.has(item.unit!));
}

/** Display suffix like " kg" for loose-unit lines (blank for pcs). */
function looseUnitSuffix(item: { unit?: string; allowFractional?: boolean }): string {
  return isLooseLine(item) ? ` ${item.unit}` : "";
}

const STATUS_MAP: Record<string, { key: string; variant: string }> = {
  draft: { key: "draft", variant: "default" },
  pending: { key: "pending", variant: "warning" },
  ordered: { key: "ordered", variant: "info" },
  partial: { key: "partial", variant: "warning" },
  received: { key: "received", variant: "success" },
  cancelled: { key: "cancelled", variant: "danger" },
};

export default function PurchaseOrdersPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [orders, setOrders] = React.useState<PurchaseOrder[]>([]);

  // Keyboard row navigation — Enter opens the PO detail (same as a row
  // click); index maps to the rendered (server-sorted) row order.
  const tbodyRef = useTableRowNav<HTMLTableSectionElement>((i) => {
    const po = orders[i];
    if (po) {
      setShowDetail(po);
      setReceiveQuantities({});
    }
  });
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);

  // Server-side sort in the shared "field.order" wire format (the API
  // clamps it to its allow-list). Numbers/dates open high→low, the PO
  // number opens A→Z.
  const [sort, setSort] = React.useState("createdAt.desc");
  function toggleSort(field: string) {
    setSort((s) => {
      if (s.startsWith(`${field}.`)) {
        return `${field}.${s.endsWith(".asc") ? "desc" : "asc"}`;
      }
      return `${field}.${field === "orderNumber" || field === "supplier" ? "asc" : "desc"}`;
    });
  }

  // Create PO state
  const [showCreate, setShowCreate] = React.useState(false);

  // Deep-link support: /purchase-orders?addProduct=<id> (Products page quick action)
  // opens the create modal with that product already added.
  const paramHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (paramHandledRef.current) return;
    const addProduct = new URLSearchParams(window.location.search).get("addProduct");
    if (addProduct) {
      paramHandledRef.current = true;
      void openCreate(addProduct);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = React.useState<Warehouse[]>([]);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [poSupplierId, setPoSupplierId] = React.useState("");
  const [poWarehouseId, setPoWarehouseId] = React.useState("");
  const [poItems, setPoItems] = React.useState<POItemForm[]>([]);

  // Live FX rates for the reverse (typed → base) conversion path.
  const [fx, setFx] = React.useState<Record<string, number> | null>(() => peekRates()?.rates ?? null);
  React.useEffect(() => {
    let alive = true;
    ensureRates().then((r) => {
      if (alive) setFx(r.rates);
    });
    return () => {
      alive = false;
    };
  }, []);
  const [poNotes, setPoNotes] = React.useState("");
  const [poExpectedDate, setPoExpectedDate] = React.useState("");
  const [poShipping, setPoShipping] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  // Field-keyed rejection from POST /api/purchase-orders, mapped back onto
  // the supplier/warehouse selects and the line list.
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  function clearFieldError(field: string) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  // Detail modal
  const [showDetail, setShowDetail] = React.useState<PurchaseOrder | null>(null);
  const [receiveQuantities, setReceiveQuantities] = React.useState<Record<string, number>>({});

  // CSV import — lines resolve against supplier/SKU/warehouse server-side
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState<ImportSummary | null>(null);
  const [resultOpen, setResultOpen] = React.useState(false);
  const importInputRef = React.useRef<HTMLInputElement>(null);

  const PO_CSV_HEADERS = ["supplier", "sku", "quantity", "unitCost", "taxRate", "warehouse", "expectedDate", "notes"];

  async function handleImportCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/purchase-orders/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("common.importFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      fetchOrders();
      setImportResult({
        created: data.created ?? data.result?.success ?? 0,
        failed: data.skipped ?? data.result?.failed ?? 0,
        errors: (data.result?.errors ?? []).map((e: { name?: string; error?: string }, i: number) => ({
          row: i + 2,
          identifier: e.name ?? "—",
          error: e.error ?? "Unknown error",
        })),
      });
      setResultOpen(true);
      if ((data.created ?? 0) > 0) {
        toast.success(t("common.importSuccess"), `${data.created ?? 0} created, ${data.skipped ?? 0} skipped`);
      }
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  // Scan-to-receive: scanning a product's barcode/SKU inside the PO
  // detail bumps that line's receive quantity by 1 (physical count
  // flow — scan each item as it comes off the truck). Human typing
  // can't trigger it (burst timing check in the hook).
  const showDetailRef = React.useRef(showDetail);
  showDetailRef.current = showDetail;
  useHardwareScanner({
    onScan: (code) => {
      const po = showDetailRef.current;
      if (!po || (po.status !== "ordered" && po.status !== "partial")) return;
      const line = po.items.find(
        (it) =>
          it.product?.barcode === code ||
          it.sku.toLowerCase() === code.toLowerCase()
      );
      if (!line) {
        toast.warning(t("purchaseOrders.scanNotOnPO"), code);
        return;
      }
      const outstanding = line.quantity - line.receivedQty;
      if (outstanding <= 0) {
        toast.warning(t("purchaseOrders.alreadyReceived"), line.productName);
        return;
      }
      setReceiveQuantities((prev) => {
        const current = prev[line.id] ?? (line.quantity - line.receivedQty);
        return { ...prev, [line.id]: Math.min(outstanding, Math.floor(current) + 1) };
      });
      toast.success(t("purchaseOrders.scanReceived"), `${line.productName} · ${code}`);
    },
    // Only active while the PO detail modal is open in a receivable state.
    enabled: Boolean(showDetail && (showDetail.status === "ordered" || showDetail.status === "partial")),
  });

  const fetchOrders = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      params.set("sort", sort);
      const res = await fetch(`/api/purchase-orders?${params}`);
      const data = await res.json();
      setOrders(data.orders ?? []);
      setTotalPages(data.pagination?.totalPages ?? 1);
    } catch { setLoadError(true); }
    setLoading(false);
  }, [page, search, statusFilter, sort]);

  React.useEffect(() => { fetchOrders(); }, [fetchOrders]);
  React.useEffect(() => { const t = setTimeout(() => setPage(1), 300); return () => clearTimeout(t); }, [search, statusFilter]);

  async function loadFormData() {
    const [sRes, wRes, pRes] = await Promise.all([
      fetch("/api/suppliers?limit=100").then((r) => r.json()),
      fetch("/api/warehouses").then((r) => r.json()),
      // Shared catalog endpoint — same rows/stock numbers as POS.
      fetch("/api/products/lookup?limit=500").then((r) => r.json()),
    ]);
    const suppliers: Supplier[] = sRes.suppliers ?? [];
    const warehouses: Warehouse[] = wRes.warehouses ?? [];
    const products: Product[] = pRes.products ?? [];
    setSuppliers(suppliers);
    setWarehouses(warehouses);
    setProducts(products);
    return { suppliers, warehouses, products };
  }

  async function openCreate(prefillProductId?: string) {
    setPoSupplierId(""); setPoWarehouseId(""); setPoItems([]); setPoNotes(""); setPoExpectedDate(""); setPoShipping(0); setFieldErrors({});
    setShowCreate(true);
    const { products: loadedProducts } = await loadFormData();
    if (prefillProductId) {
      const product = loadedProducts.find((p) => p.id === prefillProductId);
      if (product) setPoItems([poLineFromProduct(product)]);
    }
  }

  function poLineFromProduct(product: Product): POItemForm {
    return {
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      unit: product.unit ?? "pcs",
      allowFractional: product.allowFractional,
      quantity: 1,
      unitCost: product.costPrice,
      taxRate: 0,
    };
  }

  function addProductToPO(product: Product) {
    const existing = poItems.find((i) => i.productId === product.id);
    if (existing) {
      setPoItems(poItems.map((i) => i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      setPoItems([...poItems, poLineFromProduct(product)]);
    }
  }

  function removeItem(productId: string) {
    setPoItems(poItems.filter((i) => i.productId !== productId));
  }

  function updateItemQty(productId: string, qty: number) {
    setPoItems(poItems.map((i) => {
      if (i.productId !== productId) return i;
      if (!Number.isFinite(qty)) return i;
      // Loose goods accept fractional kg/L; whole units snap to integers ≥ 1
      const next = isLooseLine(i) ? Math.max(0.001, Math.round(qty * 1000) / 1000) : Math.max(1, Math.round(qty));
      return { ...i, quantity: next };
    }));
  }

  function updateItemCost(productId: string, cost: number) {
    setPoItems(poItems.map((i) => i.productId === productId ? { ...i, unitCost: Math.max(0, cost) } : i));
  }

  const poSubtotal = poItems.reduce((acc, i) => acc + i.quantity * i.unitCost, 0);
  const poTax = poItems.reduce((acc, i) => acc + Math.round(i.quantity * i.unitCost * i.taxRate / 100), 0);
  const poTotal = poSubtotal + poTax + poShipping;

  async function handleCreatePO() {
    if (!poSupplierId || !poWarehouseId || poItems.length === 0) return;
    if (saving) return; // saving guard blocks double-submit
    setSaving(true);
    try {
      const res = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: poSupplierId,
          warehouseId: poWarehouseId,
          items: poItems,
          notes: poNotes,
          expectedDate: poExpectedDate || null,
          shippingCost: poShipping,
        }),
      });
      if (!res.ok) {
        // Field-keyed errors underline the exact select/line; anything else
        // (permission denied, 500) is a single toast.
        const { fields, message } = await readApiError(res, t("common.saveFailed"));
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else toast.error(message);
        return;
      }
      setShowCreate(false);
      fetchOrders();
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setSaving(false);
    }
  }

  async function updatePOStatus(poId: string, status: string) {
    try {
      const body: Record<string, unknown> = { status };
      if (status === "received") {
        const receivedQuantities: Record<string, number> = {};
        for (const item of showDetail?.items ?? []) {
          const received = receiveQuantities[item.id] ?? (item.quantity - item.receivedQty);
          if (received > 0) receivedQuantities[item.id] = received;
        }
        body["receivedQuantities"] = receivedQuantities;
      }
      await fetch(`/api/purchase-orders/${poId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setShowDetail(null);
      fetchOrders();
    } catch { /* ignore */ }
  }

  function initReceive() {
    if (!showDetail) return;
    const qtyMap: Record<string, number> = {};
    showDetail.items.forEach((item) => {
      qtyMap[item.id] = item.quantity - item.receivedQty;
    });
    setReceiveQuantities(qtyMap);
  }

  // Fetch all POs (respects active filters) for export/print.
  const fetchAllPOs = React.useCallback(async (): Promise<PurchaseOrder[]> => {
    const collected: PurchaseOrder[] = [];
    let pageNo = 1;
    let lastTotalPages = 1;
    do {
      const params = new URLSearchParams({ page: String(pageNo), limit: "100" });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/purchase-orders?${params}`);
      const data = await res.json();
      collected.push(...(data.orders ?? []));
      lastTotalPages = data.pagination?.totalPages ?? 1;
      pageNo += 1;
    } while (pageNo <= lastTotalPages);
    return collected;
  }, [search, statusFilter]);

  // Elite shared export columns — one config drives CSV, Excel and print.
  const poExportColumns: ExportColumn<PurchaseOrder>[] = [
    { header: "orderNumber", value: (o) => o.orderNumber, print: { width: "13%" } },
    { header: "supplier", value: (o) => o.supplier?.name ?? "", print: { strong: true } },
    { header: "warehouse", value: (o) => o.warehouse?.name ?? "", omitPrint: true },
    { header: "status", value: (o) => o.status, print: { align: "center" } },
    { header: "items", value: (o) => String(o._count?.items ?? o.items?.length ?? 0), excelStyle: "int", print: { align: "right" } },
    { header: "subtotal", value: (o) => centsToMajorString(o.subtotal), excelStyle: "money", print: { align: "right", muted: true } },
    { header: "tax", value: (o) => centsToMajorString(o.taxAmount), excelStyle: "money", print: { align: "right", muted: true } },
    { header: "shipping", value: (o) => centsToMajorString(o.shippingCost), excelStyle: "money", print: { align: "right", muted: true } },
    {
      header: "total",
      value: (o) => centsToMajorString(o.total),
      excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.total, 0)) },
    },
    { header: "expectedDate", value: (o) => (o.expectedDate ? o.expectedDate.split("T")[0]! : ""), omitPrint: true },
    { header: "createdAt", value: (o) => o.createdAt.split("T")[0]!, print: { label: "Date", width: "12%" } },
  ];

  async function exportCSV() {
    try {
      const collected = await fetchAllPOs();
      downloadCsv(
        "purchase-orders",
        poExportColumns.map((c) => c.header),
        collected.map((o) => poExportColumns.map((c) => c.value(o)))
      );
      toast.success(t("common.exportStarted"), `${collected.length} ${t("purchaseOrders.count")}`);
    } catch {
      toast.error(t("common.exportFailed"), t("common.exportFailedDesc"));
    }
  }

  // Printed A4 PO ledger via the shared report engine
  const printPOLedger = async () => {
    const collected = await fetchAllPOs();
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("purchaseOrders.title"),
        kicker: "Purchase Orders Ledger",
        kpis: [
          { label: t("purchaseOrders.count"), value: String(collected.length) },
          { label: t("purchaseOrders.total"), value: formatCurrency(collected.reduce((s, o) => s + o.total, 0)), tone: "positive" },
        ],
        columns: poExportColumns.map((c) => ({
          label: c.print?.label ?? c.header,
          align: c.print?.align,
          width: c.print?.width,
          strong: c.print?.strong,
          muted: c.print?.muted,
          value: (row: PurchaseOrder) => String(c.value(row) ?? ""),
          total: c.print?.total,
        })),
        rows: collected,
        totalsLabel: t("purchaseOrders.total"),
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  // PO print payload shared by Print (window) and Preview (in-app modal)
  const poPrintPayload = (po: PurchaseOrder) => ({
    poNumber: po.orderNumber,
    status: po.status,
    orderDate: new Date(po.createdAt).toLocaleDateString(),
    expectedDate: po.expectedDate ? new Date(po.expectedDate).toLocaleDateString() : null,
    supplier: { name: po.supplier?.name ?? "" },
    createdBy: po.createdBy?.name ?? null,
    notes: po.notes,
    items: po.items.map((it) => ({
      productName: it.productName,
      sku: it.sku,
      quantity: it.quantity,
      unitCost: it.unitCost,
      lineTotal: it.total,
      receivedQty: it.receivedQty,
    })),
  });

  // Print a single professional PO document
  const printSinglePO = (po: PurchaseOrder) => {
    printPurchaseOrder(
      poPrintPayload(po),
      { storeName: t("app.name") },
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  // Eyeball the same document in-app before printing
  const previewSinglePO = async (po: PurchaseOrder) => {
    await previewPurchaseOrder(poPrintPayload(po), { storeName: t("app.name") }, {
      rtl: dir === "rtl",
      filename: po.orderNumber,
    });
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={t("purchaseOrders.title")}
        description={`${orders.length} ${t("purchaseOrders.count")}`}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("purchaseOrders.title") },
        ]}
        actions={
          <>
          <ExportMenu<PurchaseOrder>
            fileStem="purchase-orders"
            sheetName="Purchase Orders"
            rows={orders}
            columns={poExportColumns}
            template={{ headers: PO_CSV_HEADERS, exampleRows: [
              ["Fresh Foods Ltd", "BEV-0001", "48", "0.85", "", "", "2026-10-01", "Weekly restock"],
              ["", "GRN-0042", "25", "8.50", "5", "", "", ""],
              ["Grain Co", "GRN-0007", "60", "2.20", "", "MAIN", "2026-10-05", "Bulk order"],
            ] }}
            customItems={[{ label: t("export.fetchAllThenCsv"), icon: "csv", onSelect: exportCSV }]}
            printKicker="Purchase Orders Ledger"
            printTotalsLabel={t("purchaseOrders.total")}
            onPrint={printPOLedger}
            disabled={orders.length === 0}
          />
          <Button variant="secondary" loading={importing} onClick={() => importInputRef.current?.click()}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            {t("common.import")}
          </Button>
          <input ref={importInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCSV} />
          <Button onClick={() => openCreate()}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t("purchaseOrders.createPO")}
          </Button>
          </>
        }
      />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <svg className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("products.search")}
            className="h-10 w-full rounded-lg border border-neu-hairline bg-neu-bg ps-10 pe-4 text-sm text-neu-primary placeholder:text-neu-faint neu-focus" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary neu-focus">
          <option value="">{t("common.all")}</option>
          {Object.entries(STATUS_MAP).map(([key, val]) => (                  <option key={key} value={key}>{t(`purchaseOrders.${val.key}`)}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-neu-hairline bg-neu-bg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neu-hairline bg-neu-sunken">
                <SortableTh label={t("purchaseOrders.orderNumber")} active={sort.startsWith("orderNumber.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("orderNumber")} />
                <SortableTh label={t("purchaseOrders.supplier")} active={sort.startsWith("supplier.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("supplier")} />
                <SortableTh label={t("purchaseOrders.date")} className="hidden md:table-cell" active={sort.startsWith("createdAt.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("createdAt")} />
                <SortableTh label={t("purchaseOrders.expectedDate")} className="hidden lg:table-cell" active={sort.startsWith("expectedDate.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("expectedDate")} />
                <SortableTh label={t("purchaseOrders.total")} align="end" active={sort.startsWith("total.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("total")} />
                <th className="text-center px-4 py-3 font-medium text-neu-muted">{t("purchaseOrders.status")}</th>
                <th className="text-end px-4 py-3 font-medium text-neu-muted">{t("products.actions")}</th>
              </tr>
            </thead>
            <tbody ref={tbodyRef} className="divide-y divide-neu-hairline">
              {loading ? (
                <TableSkeleton rows={5} />
              ) : loadError ? (
                <tr>
                  <td colSpan={7} className="px-4 py-0">
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
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-0">
                    <EmptyState
                      bare
                      icon={
                        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                        </svg>
                      }
                      title={t("purchaseOrders.empty")}
                      description={t("purchaseOrders.emptyHint")}
                    />
                  </td>
                </tr>
              ) : (
                orders.map((po) => {
                  const st = STATUS_MAP[po.status] ?? STATUS_MAP["draft"];
                  return (
                    <tr key={po.id} data-nav-row data-nav-label={`${po.orderNumber} ${po.supplier.name}`} className="hover:bg-neu-sunken transition-colors cursor-pointer" onClick={() => { setShowDetail(po); setReceiveQuantities({}); }}>
                      <td className="px-4 py-3 font-medium text-neu-primary">{po.orderNumber}</td>
                      <td className="px-4 py-3 text-neu-muted">{po.supplier.name}</td>
                      <td className="px-4 py-3 text-neu-faint hidden md:table-cell">{new Date(po.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-neu-faint hidden lg:table-cell">
                        {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-end font-medium text-neu-primary">{formatCurrency(po.total)}</td>
                      <td className="px-4 py-3 text-center"><Badge variant={(st?.variant ?? "default") as "success" | "warning" | "danger" | "info" | "default"}>{t(`purchaseOrders.${st?.key ?? "draft"}`)}</Badge></td>
                      <td className="px-4 py-3 text-end" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {po.status === "draft" && (
                            <Button variant="ghost" size="xs" onClick={() => updatePOStatus(po.id, "pending")}>{t("purchaseOrders.confirmPO")}</Button>
                          )}
                          {(po.status === "ordered" || po.status === "partial") && (
                            <Button variant="success" size="xs" onClick={() => { setShowDetail(po); setTimeout(initReceive, 100); }}>
                              {t("purchaseOrders.receivePO")}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-neu-hairline px-4 py-3">
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("common.previous")}</Button>
            <span className="text-sm text-neu-faint">{t("common.page")} {page} {t("common.of")} {totalPages}</span>
            <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{t("common.next")}</Button>
          </div>
        )}
      </div>

      {/* ═══ CREATE PO MODAL ═══ */}
      <Dialog open={showCreate} onOpenChange={(o) => !o && setShowCreate(false)}>
        <DialogContent size="xl" className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("purchaseOrders.createPO")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
              {/* Supplier & Warehouse */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neu-primary mb-1">{t("purchaseOrders.supplier")} *</label>
                  <select value={poSupplierId}
                    onChange={(e) => { setPoSupplierId(e.target.value); clearFieldError("supplierId"); }}
                    className={`h-10 w-full rounded-lg border bg-neu-bg px-3 text-sm neu-focus ${fieldErrors["supplierId"] ? "border-neu-ink-red" : "border-neu-hairline"}`}>
                    <option value="">{t("purchaseOrders.selectSupplier")}</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {fieldErrors["supplierId"] && <p className="mt-1 text-xs text-neu-ink-red">{fieldErrors["supplierId"]}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-neu-primary mb-1">{t("pos.delivery")} *</label>
                  <select value={poWarehouseId}
                    onChange={(e) => { setPoWarehouseId(e.target.value); clearFieldError("warehouseId"); }}
                    className={`h-10 w-full rounded-lg border bg-neu-bg px-3 text-sm neu-focus ${fieldErrors["warehouseId"] ? "border-neu-ink-red" : "border-neu-hairline"}`}>
                    <option value="">{t("purchaseOrders.selectWarehouse")}</option>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
                  </select>
                  {fieldErrors["warehouseId"] && <p className="mt-1 text-xs text-neu-ink-red">{fieldErrors["warehouseId"]}</p>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neu-primary mb-1">{t("purchaseOrders.expectedDate")}</label>
                  <input type="date" value={poExpectedDate} onChange={(e) => setPoExpectedDate(e.target.value)}
                    className="h-10 w-full rounded-lg border border-neu-hairline px-3 text-sm neu-focus" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neu-primary mb-1">{t("purchaseOrders.shipping")}</label>
                  <input type="number" value={poShipping} onChange={(e) => setPoShipping(parseInt(e.target.value) || 0)} min={0}
                    className="h-10 w-full rounded-lg border border-neu-hairline px-3 text-sm neu-focus" />
                </div>
              </div>

              {/* Product Search */}
              <div>
                <label className="block text-sm font-medium text-neu-primary mb-1">{t("purchaseOrders.addItem")}</label>
                <div className="relative">
                  <svg className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input type="text" placeholder={t("purchaseOrders.searchProducts")}
                    className="h-10 w-full rounded-lg border border-neu-hairline bg-neu-bg ps-10 pe-4 text-sm neu-focus" />
                </div>
                {fieldErrors["items"] && <p className="mt-1 text-xs text-neu-ink-red">{fieldErrors["items"]}</p>}
                <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-neu-hairline divide-y divide-neu-hairline">
                  {products.slice(0, 10).map((p) => (
                    <button key={p.id} onClick={() => { addProductToPO(p); clearFieldError("items"); }}
                      className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-neu-sunken transition-colors text-start">
                      <div>
                        <p className="font-medium text-neu-primary">{p.name}</p>
                        <p className="text-xs text-neu-faint">{t("products.sku")}: {p.sku}{p.unit && !WHOLE_UNITS.has(p.unit) ? ` · ${p.unit}` : ""}</p>
                      </div>
                      <span className="text-sm text-neu-faint">{formatCurrency(p.costPrice)}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Items Table */}
              {poItems.length > 0 && (
                <div className="rounded-lg border border-neu-hairline overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-neu-sunken border-b border-neu-hairline">
                        <th className="text-start px-3 py-2 font-medium text-neu-muted">{t("products.name")}</th>
                        <th className="text-end px-3 py-2 font-medium text-neu-muted">{t("inventory.quantity")}</th>
                        <th className="text-end px-3 py-2 font-medium text-neu-muted">{t("purchaseOrders.unitCost")}</th>
                        <th className="text-end px-3 py-2 font-medium text-neu-muted">{t("purchaseOrders.lineTotal")}</th>
                        <th className="px-3 py-2 w-10" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neu-hairline">
                      {poItems.map((item) => (
                        <tr key={item.productId}>
                          <td className="px-3 py-2">
                            <p className="font-medium text-neu-primary">{item.productName}</p>
                            <p className="text-xs text-neu-faint">{item.sku}{looseUnitSuffix(item) && ` · ${item.unit}`}</p>
                          </td>
                          <td className="px-3 py-2 text-end whitespace-nowrap">
                            <input type="number" value={item.quantity} min={isLooseLine(item) ? 0.001 : 1} step={isLooseLine(item) ? "any" : "1"}
                              onChange={(e) => updateItemQty(item.productId, parseFloat(e.target.value))}
                              className="h-8 w-20 rounded border border-neu-hairline px-2 text-sm text-end tabular-nums neu-focus" />
                            {looseUnitSuffix(item) && <span className="ms-1 text-[10px] text-neu-faint">{item.unit}</span>}
                          </td>
                          <td className="px-3 py-2 text-end">
                            {/* Value is display-major (converted when a display
                                currency is active) and stored back as base
                                cents on every keystroke — never raw cents. */}
                            <input type="number" value={baseCentsToDisplayMajorStr(item.unitCost, fx)} min={0} step="0.01"
                              onChange={(e) => updateItemCost(item.productId, displayMajorToBaseCents(parseFloat(e.target.value) || 0, fx))}
                              className="h-8 w-20 rounded border border-neu-hairline px-2 text-sm text-end neu-focus" />
                          </td>
                          <td className="px-3 py-2 text-end font-medium">{formatCurrency(item.quantity * item.unitCost)}</td>
                          <td className="px-3 py-2">
                            <button onClick={() => removeItem(item.productId)} className="rounded p-1 text-neu-faint hover:text-neu-ink-red hover:bg-neu-wash-red">
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-neu-primary mb-1">{t("purchaseOrders.notes")}</label>
                <textarea value={poNotes} onChange={(e) => setPoNotes(e.target.value)} rows={2}
                  className="w-full rounded-lg border border-neu-hairline px-3 py-2 text-sm resize-none neu-focus" />
              </div>

              {/* Totals */}
              <div className="rounded-lg bg-neu-sunken p-4 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-neu-faint">{t("purchaseOrders.subtotal")}</span><span className="font-medium">{formatCurrency(poSubtotal)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-neu-faint">{t("products.tax")}</span><span className="font-medium">{formatCurrency(poTax)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-neu-faint">{t("purchaseOrders.shipping")}</span><span className="font-medium">{formatCurrency(poShipping)}</span></div>
                <div className="flex border-t border-neu-hairline pt-2 text-base font-semibold">
                  <span>{t("purchaseOrders.total")}</span><span className="ms-auto">{formatCurrency(poTotal)}</span>
                </div>
              </div>
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setShowCreate(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleCreatePO} loading={saving} disabled={!poSupplierId || !poWarehouseId || poItems.length === 0}>
              {t("purchaseOrders.confirmPO")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ DETAIL / RECEIVE MODAL ═══ */}
      <Dialog open={Boolean(showDetail)} onOpenChange={(o) => !o && setShowDetail(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            {showDetail ? (
            <div className="flex w-full items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{showDetail.orderNumber}</h2>
                <p className="text-sm text-neu-faint">{showDetail.supplier.name}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => void previewSinglePO(showDetail)}>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {t("common.preview")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => printSinglePO(showDetail)}>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5z" />
                  </svg>
                  {t("common.print")}
                </Button>
                <Badge variant={(STATUS_MAP[showDetail.status]?.variant ?? "default") as "success" | "warning" | "danger" | "info" | "default"}>
                  {t(`purchaseOrders.${STATUS_MAP[showDetail.status]?.key ?? "draft"}`)}
                </Badge>
                <button onClick={() => setShowDetail(null)} className="rounded-lg p-1 text-neu-faint hover:bg-neu-sunken">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            ) : null}
          </DialogHeader>
          <DialogBody className="space-y-4">
            {showDetail ? (
              <>
              {/* Meta */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><p className="text-neu-faint">{t("purchaseOrders.supplier")}</p><p className="font-medium">{showDetail.supplier.name}</p></div>
                <div><p className="text-neu-faint">{t("inventory.warehouse")}</p><p className="font-medium">{showDetail.warehouse.name}</p></div>
                <div><p className="text-neu-faint">{t("purchaseOrders.date")}</p><p className="font-medium">{new Date(showDetail.createdAt).toLocaleDateString()}</p></div>
                <div><p className="text-neu-faint">{t("common.createdBy")}</p><p className="font-medium">{showDetail.createdBy.name}</p></div>
              </div>

              {/* Items */}
              <div className="rounded-lg border border-neu-hairline overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-neu-sunken border-b border-neu-hairline">
                      <th className="text-start px-3 py-2 font-medium text-neu-muted">{t("products.name")}</th>
                      <th className="text-end px-3 py-2 font-medium text-neu-muted">{t("inventory.quantity")}</th>
                      <th className="text-end px-3 py-2 font-medium text-neu-muted">{t("purchaseOrders.received")}</th>
                      <th className="text-end px-3 py-2 font-medium text-neu-muted">{t("purchaseOrders.unitCost")}</th>
                      <th className="text-end px-3 py-2 font-medium text-neu-muted">{t("purchaseOrders.lineTotal")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neu-hairline">
                    {showDetail.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-3 py-2">
                          <p className="font-medium text-neu-primary">{item.productName}</p>
                          <p className="text-xs text-neu-faint">{item.sku}{looseUnitSuffix(item.product ?? {}) && ` · ${item.product?.unit}`}</p>
                        </td>
                        <td className="px-3 py-2 text-end tabular-nums">
                          {item.quantity}
                          {looseUnitSuffix(item.product ?? {}) && <span className="ms-0.5 text-[10px] text-neu-faint">{item.product?.unit}</span>}
                        </td>
                        <td className="px-3 py-2 text-end whitespace-nowrap">
                          {showDetail.status === "ordered" || showDetail.status === "partial" ? (
                            <>
                              <input type="number" value={receiveQuantities[item.id] ?? (item.quantity - item.receivedQty)} min={0} max={item.quantity - item.receivedQty}
                                step={looseUnitSuffix(item.product ?? {}) ? "any" : "1"}
                                onChange={(e) => setReceiveQuantities({ ...receiveQuantities, [item.id]: parseFloat(e.target.value) || 0 })}
                                className="h-8 w-20 rounded border border-neu-hairline px-2 text-sm text-end tabular-nums neu-focus" />
                              {looseUnitSuffix(item.product ?? {}) && <span className="ms-1 text-[10px] text-neu-faint">{item.product?.unit}</span>}
                            </>
                          ) : (
                            <span className="tabular-nums">
                              {item.receivedQty}
                              {looseUnitSuffix(item.product ?? {}) && <span className="ms-0.5 text-[10px] text-neu-faint">{item.product?.unit}</span>}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-end">{formatCurrency(item.unitCost)}</td>
                        <td className="px-3 py-2 text-end font-medium">{formatCurrency(item.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="rounded-lg bg-neu-sunken p-4 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-neu-faint">{t("purchaseOrders.subtotal")}</span><span>{formatCurrency(showDetail.subtotal)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-neu-faint">{t("products.tax")}</span><span>{formatCurrency(showDetail.taxAmount)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-neu-faint">{t("purchaseOrders.shipping")}</span><span>{formatCurrency(showDetail.shippingCost)}</span></div>
                <div className="flex border-t border-neu-hairline pt-2 text-base font-semibold">
                  <span>{t("purchaseOrders.total")}</span><span className="ms-auto">{formatCurrency(showDetail.total)}</span>
                </div>
              </div>
              </>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex-wrap dark:bg-neu-sunken/40">
            {showDetail && showDetail.status === "draft" && (
              <Button variant="primary" onClick={() => updatePOStatus(showDetail.id, "pending")}>{t("purchaseOrders.confirmPO")}</Button>
            )}
            {showDetail && (showDetail.status === "ordered" || showDetail.status === "partial") && (
              <>
                <Button variant="danger" size="sm" onClick={() => updatePOStatus(showDetail.id, "cancelled")}>{t("purchaseOrders.cancelPO")}</Button>
                <Button variant="success" onClick={() => updatePOStatus(showDetail.id, "received")}>{t("purchaseOrders.receivePO")}</Button>
              </>
            )}
            {showDetail && showDetail.status === "pending" && (
              <Button variant="primary" onClick={() => updatePOStatus(showDetail.id, "ordered")}>{t("purchaseOrders.markOrdered")}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ IMPORT RESULT ═══ */}
      <ImportResultDialog
        open={resultOpen}
        onClose={() => setResultOpen(false)}
        result={importResult}
        entityLabel={t("purchaseOrders.title")}
      />
    </div>
  );
}
