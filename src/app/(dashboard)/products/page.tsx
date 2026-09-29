"use client";

import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { BarcodeLabel, BarcodeLabelSheet } from "@/components/products/barcode-label";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductForm } from "@/components/products/product-form";
import { SmartImage } from "@/components/ui/smart-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { normalizeImageFile } from "@/lib/image-normalize";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { toast } from "@/stores/toast-store";
import { formatCurrency, cn } from "@/lib/utils";
import { downloadCsv, downloadTemplate } from "@/lib/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { ImportResultDialog, type ImportSummary } from "@/components/import/import-result-dialog";
import { useHardwareScanner } from "@/hooks/use-hardware-scanner";

/* ═══════════════════════════════════════════════════════════════
   PRODUCTS PAGE
   Full CRUD interface with search, filters, pagination,
   and create/edit modals.
   ═══════════════════════════════════════════════════════════════ */

/* ─── CSV shape (shared by full export / selected export / template) ───
   Headers are the same field names the import API accepts, so an
   exported file can be edited and re-imported round-trip. */
const PRODUCT_CSV_HEADERS = [
  "name", "sku", "barcode", "description", "category", "brand",
  "unit", "price", "cost", "taxRate", "status", "minStock",
];

function productToCsvRow(p: Product): string[] {
  return [
    p.name,
    p.sku,
    p.barcode ?? "",
    "",
    p.category?.name ?? "",
    p.brand?.name ?? "",
    p.unit && p.unit !== "pcs" ? p.unit : "pcs",
    (p.unitPrice / 100).toFixed(2),
    (p.costPrice / 100).toFixed(2),
    p.taxRate != null ? String(p.taxRate) : "0",
    p.status,
    String(p.minStockLevel),
  ];
}

interface Product {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  unitPrice: number;
  costPrice: number;
  taxRate?: number;
  status: string;
  totalStock: number;
  totalAvailable?: number;
  available?: number;
  stockStatus?: "out" | "low" | "ok";
  minStockLevel: number;
  trackInventory?: boolean;
  allowDiscount?: boolean;
  unit?: string;
  allowFractional?: boolean;
  sellByValue?: boolean;
  category: { id: string; name: string; slug: string };
  brand?: { id: string; name: string; slug: string };
  imageUrl?: string;
  images?: string | null; // raw JSON array from the API
  unitConversions?: string | null; // raw JSON array from the API
  createdAt: string;
}

interface Category {
  id: string;
  name: string;
  _count?: { products: number };
}

interface ProductsResponse {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/** Parse the product's `images` JSON string into a displayable array. */
function parseProductImages(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/** Parse the product's `unitConversions` JSON string into an array. */
function parseUnitConversions(raw?: string | null): Array<{ unit: string; factor: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is { unit: string; factor: number } =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { unit?: unknown }).unit === "string" &&
        typeof (c as { factor?: unknown }).factor === "number"
    );
  } catch {
    return [];
  }
}

export default function ProductsPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t } = useI18n();
  const [products, setProducts] = React.useState<Product[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);

  // Deep-linkable state — filters, page, and view mode live in the URL
  // (shareable / bookmarkable). IMPORTANT: initial state must MATCH the
  // server render (defaults) — the URL is applied in a post-mount effect
  // below. Reading window.location during the first render makes the
  // client's first render differ from the SSR HTML and React throws the
  // whole tree away (hydration mismatch → blank flash → flicker).
  const clampPage = (raw: string | null) => {
    const n = parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };

  const [pagination, setPagination] = React.useState({
    page: 1,
    pageSize: 15,
    total: 0,
    totalPages: 0,
    hasNext: false,
  });

  // Filters
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [brandFilter, setBrandFilter] = React.useState("");
  const [view, setView] = React.useState<"table" | "grid">("table");
  const hasFilters = search || statusFilter || categoryFilter || brandFilter;
  const filtersCount = [search, statusFilter, categoryFilter, brandFilter].filter(Boolean).length;
  const [brands, setBrands] = React.useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const allOnPageSelected = products.length > 0 && products.every((p) => selected.has(p.id));

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedProducts = React.useMemo(
    () => products.filter((p) => selected.has(p.id)),
    [products, selected]
  );

  // Modal state
  const [createOpen, setCreateOpen] = React.useState(false);
  // Scan-to-create hand-off from the POS: /products?createWithBarcode=…
  // opens the new-product form with the scanned code prefilled.
  const [prefillBarcode, setPrefillBarcode] = React.useState<string | null>(null);
  React.useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("createWithBarcode");
    if (code) {
      setPrefillBarcode(code);
      setCreateOpen(true);
      // Clean the URL so a refresh doesn't re-open the form.
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const [editProduct, setEditProduct] = React.useState<Product | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState<Product | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [bulkUpdating, setBulkUpdating] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState<ImportSummary | null>(null);
  const [resultOpen, setResultOpen] = React.useState(false);
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const [barcodeProduct, setBarcodeProduct] = React.useState<Product | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [priceAdjOpen, setPriceAdjOpen] = React.useState(false);
  const [priceAdjMode, setPriceAdjMode] = React.useState<"percent" | "amount">("percent");
  const [priceAdjValue, setPriceAdjValue] = React.useState("");
  const [priceAdjTarget, setPriceAdjTarget] = React.useState<"unitPrice" | "costPrice" | "both">("unitPrice");
  const [barcodeLabelSheetItems, setBarcodeLabelSheetItems] = React.useState<
    Array<{ name: string; sku: string; barcode?: string; price: number; unit?: string }>
  >([]);
  const [imageUploadProduct, setImageUploadProduct] = React.useState<Product | null>(null);
  const [uploading, setUploading] = React.useState(false);
  // Full-screen preview of a product's gallery from the table/grid.
  const [lightboxState, setLightboxState] = React.useState<{ images: string[]; index: number; alt: string } | null>(null);

  // Fetch products
  const fetchProducts = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({
        page: String(pagination.page),
        pageSize: String(pagination.pageSize),
      });
      if (search) params.set("search", search);
      // "all" makes the server drop the default active-only filter — the
      // All Status option used to silently show just active products.
      params.set("status", statusFilter || "all");
      if (categoryFilter) params.set("categoryId", categoryFilter);
      if (brandFilter) params.set("brandId", brandFilter);

      const res = await fetch(`/api/products?${params}`);
      const data: ProductsResponse = await res.json();
      // A 500 (dev compile, network hiccup) must never blank the table or
      // crash the render — fall back to the previous state instead.
      if (!res.ok || !Array.isArray(data.items)) {
        console.error("Failed to fetch products:", res.status, data);
        setProducts([]);
        setLoadError(true);
        return;
      }
      setProducts(data.items);
      setPagination((prev) => ({
        ...prev,
        total: data.total ?? 0,
        totalPages: data.totalPages ?? 0,
        hasNext: data.hasNext ?? false,
      }));
    } catch (error) {
      console.error("Failed to fetch products:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, search, statusFilter, categoryFilter, brandFilter]);

  // Fetch categories + brands
  React.useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => setCategories(d.categories ?? []))
      .catch(console.error);
    fetch("/api/brands")
      .then((r) => r.json())
      .then((d) => setBrands(d.brands ?? []))
      .catch(console.error);
  }, []);

  // Apply the deep-linked URL ONCE, post-mount, before the first fetch
  // (initial state above matches SSR on purpose; see the comment there).
  const appliedUrlRef = React.useRef(false);
  React.useEffect(() => {
    if (appliedUrlRef.current) return;
    appliedUrlRef.current = true;
    const qs = new URLSearchParams(window.location.search);
    const s = qs.get("search");
    const st = qs.get("status");
    const c = qs.get("categoryId");
    const b = qs.get("brandId");
    const pg = clampPage(qs.get("page"));
    const v = qs.get("view") === "grid" ? "grid" : "table";
    if (s) {
      setSearchInput(s);
      setSearch(s);
    }
    if (st) setStatusFilter(st);
    if (c) setCategoryFilter(c);
    if (b) setBrandFilter(b);
    if (pg > 1) {
      skipNextResetRef.current = true;
      setPagination((p) => ({ ...p, page: pg }));
    }
    setView(v);
  }, []);

  // Fetch products on filter change
  React.useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Reset page when filters change (skips the run triggered by the
  // post-mount URL application so a deep-linked page number survives).
  const skipNextResetRef = React.useRef(false);
  React.useEffect(() => {
    if (skipNextResetRef.current) {
      skipNextResetRef.current = false;
      return;
    }
    setPagination((prev) => ({ ...prev, page: 1 }));
  }, [search, statusFilter, categoryFilter, brandFilter]);

  // Keep the URL in sync with filters/page/view — shareable + bookmarkable,
  // and browser Back/Forward steps through filter states.
  React.useEffect(() => {
    const qs = new URLSearchParams();
    if (search) qs.set("search", search);
    if (statusFilter) qs.set("status", statusFilter);
    if (categoryFilter) qs.set("categoryId", categoryFilter);
    if (brandFilter) qs.set("brandId", brandFilter);
    if (pagination.page > 1) qs.set("page", String(pagination.page));
    if (view !== "table") qs.set("view", view);
    const next = qs.toString();
    const prev = window.location.search.replace(/^\?/, "");
    if (next !== prev) {
      window.history.replaceState(null, "", next ? `?${next}` : window.location.pathname);
    }
  }, [search, statusFilter, categoryFilter, brandFilter, pagination.page, view]);

  // Search debounce
  const [searchInput, setSearchInput] = React.useState("");

  // Scan-anywhere: a hardware scanner burst fills the search box and
  // filters the table instantly — no click, no paste.
  useHardwareScanner({
    onScan: (code) => {
      setSearchInput(code);
      setSearch(code);
      toast.info(t("products.barcodeScanned"), code);
    },
    // Don't hijack typing while the create/edit dialogs are open.
    enabled: !createOpen && !editProduct && !deleteConfirm,
  });

  // View state must never outlive the catalog data
  React.useEffect(() => {
    setSelected(new Set());
  }, [pagination.page, search, statusFilter, categoryFilter, brandFilter]);
  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Support deep links from the global search (⌘K): /products?search=...
  // — handled by the post-mount URL effect above.

  // Handle delete
  async function handleDelete() {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await fetch(`/api/products/${deleteConfirm.id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      fetchProducts();
      toast.success(t("products.deleted"), `${deleteConfirm.name} ${t("products.removedFromCatalog")}`);
    } catch (error) {
      console.error("Failed to delete:", error);
      toast.error(t("products.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  // Download helper — triggers a client-side CSV file save.
  // Export the current catalog (respects active filters) as CSV.
  // Columns mirror the import template exactly (round-trip safe).
  async function exportCSV() {
    setExporting(true);
    try {
      const collected: Product[] = [];
      let pageNo = 1;
      let totalPages = 1;
      do {
        const params = new URLSearchParams({ page: String(pageNo), pageSize: "100" });
        if (search) params.set("search", search);
        params.set("status", statusFilter || "all");
        if (categoryFilter) params.set("categoryId", categoryFilter);
        if (brandFilter) params.set("brandId", brandFilter);
        const res = await fetch(`/api/products?${params}`);
        const data = await res.json();
        collected.push(...(data.items ?? []));
        totalPages = data.totalPages ?? 1;
        pageNo += 1;
      } while (pageNo <= totalPages);

      downloadCsv("products", PRODUCT_CSV_HEADERS, collected.map(productToCsvRow));
      toast.success(t("common.exportStarted"), `${collected.length} ${t("products.total")}`);
    } catch {
      toast.error(t("common.exportFailed"), t("common.exportFailedDesc"));
    } finally {
      setExporting(false);
    }
  }

  // Export only the selected rows (same columns as the full export).
  function exportSelectedCsv() {
    const items = selectedProducts;
    if (items.length === 0) return;
    downloadCsv("products", PRODUCT_CSV_HEADERS, items.map(productToCsvRow));
    toast.success(t("common.exportStarted"), `${items.length} ${t("products.total")}`);
  }

  // Download the import template (headers + 2 example rows).
  function downloadImportTemplate() {
    downloadTemplate("products", PRODUCT_CSV_HEADERS, [
      ["Coca-Cola Classic 330ml", "BEV-0001", "5449000000996", "Chilled can", "Beverages", "Coca-Cola", "pcs", "1.50", "0.90", "0", "active", "24"],
      ["Basmati Rice 5kg", "GRN-0042", "", "Aged long grain", "Groceries", "", "kg", "12.00", "8.50", "5", "active", "10"],
    ]);
    toast.success(t("common.importTemplate"), t("common.importTemplateDesc"));
  }

  // Bulk update (status change / category move / brand / price scaling)
  // via the bulk API
  async function bulkUpdate(payload: {
    status?: string;
    categoryId?: string;
    brandId?: string;
    priceAdjust?: { mode: "percent" | "amount"; value: number; applyTo: "unitPrice" | "costPrice" | "both" };
  }) {
    setBulkUpdating(true);
    try {
      const res = await fetch("/api/products/bulk", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], ...payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("common.error"), typeof data.error === "string" ? data.error : t("products.bulkFailed"));
        return;
      }
      setSelected(new Set());
      fetchProducts();
      toast.success(t("products.bulkUpdated"), t("products.bulkUpdatedDesc").replace("{n}", String(data.updated ?? 0)));
    } catch {
      toast.error(t("common.error"), t("common.networkErrorDesc"));
    } finally {
      setBulkUpdating(false);
    }
  }

  // Import products from CSV
  async function handleImportCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/products/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("common.importFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      fetchProducts();
      // Elite result dialog: stat cards + per-row errors + error CSV
      setImportResult({
        created: data.created ?? data.result?.success ?? 0,
        failed: data.skipped ?? data.result?.failed ?? 0,
        errors: (data.result?.errors ?? []).map((e: { sku?: string; error?: string }, i: number) => ({
          row: i + 2,
          identifier: e.sku ?? "—",
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

  const statusVariant = (status: string) => {
    switch (status) {
      case "active":
        return "success" as const;
      case "inactive":
        return "warning" as const;
      case "discontinued":
        return "danger" as const;
      default:
        return "default" as const;
    }
  };

  // Elite shared export columns — one config drives CSV, Excel and the
  // printed A4 catalog (money cells styled, stock + value totals row).
  const productExportColumns: ExportColumn<Product>[] = [
    { header: "name", value: (p) => p.name, print: { width: "26%" } },
    { header: "sku", value: (p) => p.sku, print: { muted: true } },
    { header: "barcode", value: (p) => p.barcode ?? "", omitPrint: true },
    { header: "description", value: () => "", omitPrint: true },
    { header: "category", value: (p) => p.category?.name ?? "" },
    { header: "brand", value: (p) => p.brand?.name ?? "" },
    { header: "unit", value: (p) => (p.unit && p.unit !== "pcs" ? p.unit : "pcs"), omitPrint: true },
    {
      header: "price",
      value: (p) => (p.unitPrice / 100).toFixed(2),
      excelStyle: "money",
      print: { align: "right", total: (rows) => formatCurrency(rows.reduce((s, r) => s + r.unitPrice, 0)) },
    },
    {
      header: "cost",
      value: (p) => (p.costPrice / 100).toFixed(2),
      excelStyle: "money",
      print: { align: "right", muted: true },
    },
    { header: "taxRate", value: (p) => (p.taxRate != null ? String(p.taxRate) : "0"), excelStyle: "percent", omitPrint: true },
    { header: "status", value: (p) => p.status, print: { align: "center" } },
    {
      header: "minStock",
      value: (p) => String(p.minStockLevel),
      excelStyle: "int",
      print: { align: "right", label: "Min" },
    },
    {
      header: "stock",
      value: (p) => String(p.totalStock ?? 0),
      excelStyle: "int",
      print: { align: "right", total: (rows) => String(rows.reduce((s, r) => s + (r.totalStock ?? 0), 0)) },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("products.title")}
        description={`${t("products.pageDescription")} — ${pagination.total} ${t("products.total")}.`}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("products.title") },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <ExportMenu
              fileStem="products"
              sheetName="Products"
              rows={products}
              columns={productExportColumns}
              disabled={pagination.total === 0}
              template={{ headers: PRODUCT_CSV_HEADERS, exampleRows: [
                ["Coca-Cola Classic 330ml", "BEV-0001", "5449000000996", "Chilled can", "Beverages", "Coca-Cola", "pcs", "1.50", "0.90", "0", "active", "24"],
                ["Basmati Rice 5kg", "GRN-0042", "", "Aged long grain", "Groceries", "", "kg", "12.00", "8.50", "5", "active", "10"],
              ] }}
            />
            <Button variant="secondary" loading={importing} onClick={() => importInputRef.current?.click()}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              {t("common.import")}
            </Button>
            <input ref={importInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCSV} />
            <Button onClick={() => setCreateOpen(true)}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              {t("products.addProduct")}
            </Button>
          </div>
        }
      />

      {/* Filters Bar */}
      <Card>
        <CardContent className="p-4">
          <div className="filters-bar">
            <Input
              placeholder={t("products.search")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              leftIcon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
              wrapperClassName="w-full sm:w-[220px] sm:min-w-[220px]"
            />
            <select
              className="h-9 min-w-0 flex-1 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary transition-colors sm:w-[150px] sm:flex-none neu-focus"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label={t("products.category")}
            >
              <option value="">{t("products.allCategories")}</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
            <select
              className="h-9 min-w-0 flex-1 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary transition-colors sm:w-[150px] sm:flex-none neu-focus"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              aria-label={t("products.brand")}
            >
              <option value="">{t("products.allBrands")}</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
            <select
              className="h-9 min-w-0 flex-1 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary transition-colors sm:w-[140px] sm:flex-none neu-focus"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label={t("products.status")}
            >
              <option value="">{t("products.allStatus")}</option>
              <option value="active">{t("products.active")}</option>
              <option value="inactive">{t("products.inactive")}</option>
              <option value="discontinued">{t("products.discontinued")}</option>
            </select>
            <div className="pos-segmented shrink-0" role="group" aria-label={t("products.view")}>
              <button
                type="button"
                className="pos-segmented-btn h-9"
                aria-pressed={view === "table"}
                title={t("products.tableView")}
                onClick={() => setView("table")}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span className="hidden lg:inline">{t("products.tableView")}</span>
              </button>
              <button
                type="button"
                className="pos-segmented-btn h-9"
                aria-pressed={view === "grid"}
                title={t("products.gridView")}
                onClick={() => setView("grid")}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
                <span className="hidden lg:inline">{t("products.gridView")}</span>
              </button>
            </div>
            {hasFilters && (
              <div className="flex w-full items-center justify-between gap-2">
                <p className="text-xs font-medium text-neu-faint">
                  {t("products.filtersApplied")} <span className="font-semibold text-neu-primary">{filtersCount}</span>
                </p>
                <button
                  type="button"
                  className="clear-filters-btn"
                  onClick={() => {
                    setSearchInput("");
                    setSearch("");
                    setCategoryFilter("");
                    setBrandFilter("");
                    setStatusFilter("");
                  }}
                  disabled={filtersCount === 0}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  {t("products.clearFilters")}
                </button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Products Table */}
      <Card>
        <CardContent className="p-0">
          {/* Bulk selection toolbar — real actions over the selection */}
          {selected.size > 0 && (
            <div className="bulk-bar">
              <p className="bulk-bar-count">
                {selected.size} {t("products.selected")}
              </p>
              <div className="bulk-bar-actions">
                {/* Status change */}
                <select
                  className="h-8 rounded-lg border border-neu-accent-line bg-neu-bg px-2 text-xs font-medium text-neu-primary neu-focus"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) bulkUpdate({ status: e.target.value });
                  }}
                  disabled={bulkUpdating}
                  aria-label={t("products.setStatus")}
                >
                  <option value="">{t("products.setStatus")}…</option>
                  <option value="active">{t("products.active")}</option>
                  <option value="inactive">{t("products.inactive")}</option>
                  <option value="discontinued">{t("products.discontinued")}</option>
                </select>
                {/* Category move */}
                <select
                  className="h-8 max-w-[10rem] rounded-lg border border-neu-accent-line bg-neu-bg px-2 text-xs font-medium text-neu-primary neu-focus"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) bulkUpdate({ categoryId: e.target.value });
                  }}
                  disabled={bulkUpdating}
                  aria-label={t("products.moveToCategory")}
                >
                  <option value="">{t("products.moveToCategory")}…</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
                {/* Brand assignment ("" clears the brand) */}
                <select
                  className="h-8 max-w-[10rem] rounded-lg border border-neu-accent-line bg-neu-bg px-2 text-xs font-medium text-neu-primary neu-focus"
                  value="__none"
                  onChange={(e) => {
                    if (e.target.value === "__clear") bulkUpdate({ brandId: "" });
                    else if (e.target.value) bulkUpdate({ brandId: e.target.value });
                  }}
                  disabled={bulkUpdating}
                  aria-label={t("products.setBrand")}
                >
                  <option value="__none">{t("products.setBrand")}…</option>
                  <option value="__clear">{t("products.noBrand")}</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                {/* Price adjustment */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPriceAdjOpen(true)}
                  disabled={bulkUpdating}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {t("products.adjustPrices")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={exporting}
                  onClick={exportSelectedCsv}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  {t("common.export")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setBarcodeLabelSheetItems(selectedProducts.map((p) => ({
                      name: p.name,
                      sku: p.sku,
                      barcode: p.barcode,
                      price: p.unitPrice,
                      unit: p.unit,
                    })));
                    setSheetOpen(true);
                  }}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                  {t("products.printBarcodes")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                >
                  {t("products.deselectAll")}
                </Button>
              </div>
            </div>
          )}

          {/* ─── Table view ─── */}
          {view === "table" && (
          <div className="table-scroll-lg">
            <table className="products-table">
              <thead>
                {/* Header cells reuse the shared inventory table classes
                    (inv-th + alignment helpers) instead of re-declaring the
                    same utility soup per column. */}
                <tr className="border-b border-neu-hairline bg-neu-sunken">
                  <th scope="col" className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
                      checked={allOnPageSelected}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) products.forEach((p) => next.add(p.id));
                          else next.clear();
                          return next;
                        })
                      }
                      aria-label={t("products.selectAll")}
                    />
                  </th>
                  <th scope="col" className="inv-th">{t("products.name")}</th>
                  <th scope="col" className="inv-th hidden md:table-cell">SKU</th>
                  <th scope="col" className="inv-th hidden lg:table-cell">{t("products.category")}</th>
                  <th scope="col" className="inv-th inv-th-end">{t("products.price")}</th>
                  <th scope="col" className="inv-th inv-th-end">{t("products.stock")}</th>
                  <th scope="col" className="inv-th inv-th-center hidden sm:table-cell">{t("products.status")}</th>
                  <th scope="col" className="inv-th inv-th-end">{t("products.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neu-hairline">
                {loading ? (
                  // Shared professional skeleton (lib/components) — the same
                  // loading shape on every table in the app.
                  <TableSkeleton rows={8} />
                ) : loadError ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-0">
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
                          <Button variant="secondary" size="sm" onClick={fetchProducts}>
                            {t("common.retry")}
                          </Button>
                        }
                      />
                    </td>
                  </tr>
                ) : products.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-0">
                      <EmptyState
                        bare
                        icon={
                          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                          </svg>
                        }
                        title={search ? t("products.noMatch") : t("products.empty")}
                        description={search ? t("products.noMatchHint") : t("products.emptyHint")}
                        action={
                          !search ? (
                            <Button onClick={() => setCreateOpen(true)}>
                              {t("products.addProduct")}
                            </Button>
                          ) : undefined
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  products.map((product) => (
                    <tr
                      key={product.id}
                      className={cn(
                        "products-table-row",
                        selected.has(product.id) && "bg-neu-accent-wash/60"
                      )}
                    >
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
                          checked={selected.has(product.id)}
                          onChange={() => toggleSelected(product.id)}
                          aria-label={`${t("products.name")}: ${product.name}`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            className="cursor-zoom-in"
                            title={t("products.zoomHint")}
                            onClick={() =>
                              setLightboxState({
                                images: [
                                  ...(product.imageUrl ? [product.imageUrl] : []),
                                  ...parseProductImages(product.images).filter(
                                    (u) => u !== product.imageUrl
                                  ),
                                ],
                                index: 0,
                                alt: product.name,
                              })
                            }
                          >
                            <SmartImage
                              src={product.imageUrl}
                              alt={product.name}
                              className="product-thumb"
                              iconClassName="h-5 w-5"
                            />
                          </button>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-neu-primary truncate">
                              {product.name}
                            </p>
                            {/* The brand line is rendered even when it is empty.
                                Conditionally rendering it made the row jump
                                between 64px and 77px depending on the DATA: a
                                table whose rows change height per record reads
                                as unsettled, and it is the only ragged thing in
                                the densest view in the app. With the line always
                                reserved and pinned to 14px, the row is set by
                                the 40px thumbnail and every row matches. */}
                            <p className="truncate text-xs leading-[14px] text-neu-faint">
                              {product.brand?.name ?? "\u00A0"}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="inv-td hidden md:table-cell">
                        <span className="font-mono text-xs text-neu-muted">{product.sku}</span>
                      </td>
                      <td className="inv-td hidden lg:table-cell">
                        <span className="text-sm text-neu-muted">{product.category.name}</span>
                      </td>
                      <td className="inv-td whitespace-nowrap">
                        <span className="product-price text-sm font-semibold text-neu-primary">
                          {formatCurrency(product.unitPrice)}
                          {product.unit && product.unit !== "pcs" && (
                            <span className="product-price-unit">/{product.unit}</span>
                          )}
                        </span>
                      </td>
                      <td className="inv-td">
                        <div className="stock-cell">
                          {(() => {
                            // Shared rule (lib/stock-status): the same
                            // classification POS, Inventory and the API
                            // payload carry — sellable available vs the
                            // product's own minimum. Falls back to the
                            // raw total for rows from older caches.
                            const available = product.available ?? product.totalStock;
                            const status =
                              product.stockStatus ??
                              (available <= 0 ? "out" : available <= product.minStockLevel ? "low" : "ok");
                            // Same fill rule as the inventory table's
                            // stockBar: available vs the product minimum,
                            // clamped, with a 6% sliver so near-zero rows
                            // still show a visible nub. Hidden when the
                            // product has no minimum configured.
                            const min = product.minStockLevel;
                            const barPct =
                              min > 0
                                ? available <= 0
                                  ? 0
                                  : Math.max(6, Math.min(100, (available / min) * 100))
                                : null;
                            const barTone =
                              status === "out" ? "qty-bar-out" : status === "low" ? "qty-bar-low" : "qty-bar-ok";
                            return (
                              <div className="flex flex-col items-end gap-1.5">
                                <span
                                  className={cn(
                                    "text-sm font-medium tabular-nums",
                                    status === "low" ? "stock-low" : "text-neu-primary"
                                  )}
                                >
                                  {available}
                                  {product.unit && product.unit !== "pcs" && (
                                    <span className="text-xs text-neu-faint"> {product.unit}</span>
                                  )}
                                </span>
                                {barPct !== null && (
                                  <span className="qty-bar w-16" aria-hidden>
                                    <span className={cn("qty-bar-fill", barTone)} style={{ width: `${barPct}%` }} />
                                  </span>
                                )}
                                {status === "out" && (
                                  <span className="stock-low-label">{t("products.outOfStock")}</span>
                                )}
                                {status === "low" && (
                                  <span className="stock-low-label">{t("products.low")}</span>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </td>
                      <td className="inv-td text-center hidden sm:table-cell">
                        <Badge variant={statusVariant(product.status)} size="sm">
                          <span className="status-dot me-1" aria-hidden="true" />
                          {t(`products.${product.status}`)}
                        </Badge>
                      </td>
                      <td className="inv-td">
                        <div className="action-buttons">
                          {/* Quick restock: link to purchase orders with this product pre-loaded */}
                          {/* `asChild`, not `<a><Button/></a>`: nesting a button in a
                              link is two interactive elements for one action, and
                              the inner one carried NO accessible name at all (the
                              title sat on the anchor, not on the button). As a
                              child, the anchor IS the button and holds the name. */}
                          <Button asChild variant="ghost" size="icon-sm" className="!p-0">
                            <a
                              href={`/purchase-orders?addProduct=${encodeURIComponent(product.id)}`}
                              aria-label={t("purchaseOrders.quickRestock")}
                              title={t("purchaseOrders.quickRestock")}
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </a>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setBarcodeProduct(product)}
                            title={t("products.printBarcode")}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                            </svg>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setImageUploadProduct(product)}
                            title={t("products.uploadImage")}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                            </svg>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setEditProduct(product)}
                            title={t("common.edit")}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-neu-ink-red hover:bg-neu-wash-red"
                            onClick={() => setDeleteConfirm(product)}
                            title={t("common.delete")}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          )}

          {/* ─── Grid view (card mode) ─── */}
          {view === "grid" && (
            <div className="product-cards">
              {loading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="product-card" aria-hidden="true">
                      <div className="product-card-thumb skeleton-shimmer">
                        <div className="skeleton h-full w-full" style={{ animationDelay: `${i * 60}ms` }} />
                      </div>
                      <div className="product-card-body">
                        <div className="skeleton h-3.5 rounded" style={{ width: "70%", animationDelay: `${i * 60 + 30}ms` }} />
                        <div className="skeleton h-3 rounded" style={{ width: "40%", animationDelay: `${i * 60 + 60}ms` }} />
                      </div>
                    </div>
                  ))
                : products.length === 0
                ? (
                  <p className="col-span-full py-10 text-center text-sm text-neu-faint">
                    {search ? t("products.noMatch") : t("products.empty")}
                  </p>
                )
                : products.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className={cn("product-card", selected.has(product.id) && "ring-2 ring-neu-accent-line/40")}
                    onClick={(e) => {
                      if (e.shiftKey || e.metaKey || e.ctrlKey) {
                        toggleSelected(product.id);
                        return;
                      }
                      setEditProduct(product);
                    }}
                  >
                    <SmartImage
                      src={product.imageUrl}
                      alt={product.name}
                      className="product-card-thumb"
                      iconClassName="h-8 w-8"
                      title={product.name}
                    />
                    <div className="product-card-body">
                      <p className="product-card-name">{product.name}</p>
                      <p className="product-card-meta">
                        {product.category.name}
                        {product.brand ? ` · ${product.brand.name}` : ""}
                      </p>
                      <div className="product-card-foot">
                        <span className="product-card-price">{formatCurrency(product.unitPrice)}</span>
                        {(() => {
                          const available = product.available ?? product.totalStock;
                          const status =
                            product.stockStatus ??
                            (available <= 0 ? "out" : available <= product.minStockLevel ? "low" : "ok");
                          return (
                            <span
                              className={cn(
                                "text-xs font-medium tabular-nums",
                                status === "out" ? "text-neu-ink-red" : status === "low" ? "stock-low" : "text-neu-faint"
                              )}
                            >
                              {available}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  </button>
                ))}
            </div>
          )}

          {/* Pagination */}
          {pagination.totalPages > 0 && (
            <div className="pagination-footer">
              <p className="pagination-info hidden sm:block">
                {t("common.showing")} {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(pagination.page * pagination.pageSize, pagination.total)} {t("common.of")}{" "}
                {pagination.total} {t("products.title")}
              </p>
              <div className="pagination-controls">
                <Button
                  variant="secondary"
                  size="icon-sm"
                  disabled={!pagination.page || pagination.page <= 1}
                  onClick={() => setPagination((p) => ({ ...p, page: p.page - 1 }))}
                  aria-label={t("common.previous")}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </Button>
                <span className="pagination-page whitespace-nowrap tabular-nums">
                  {t("common.page")} {pagination.page} {t("common.of")} {pagination.totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  disabled={!pagination.hasNext}
                  onClick={() => setPagination((p) => ({ ...p, page: p.page + 1 }))}
                  aria-label={t("common.next")}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Product Modal — ProductForm owns the dialog chrome */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* eslint-disable-next-line @local/require-dialog-body -- ProductForm renders DialogHeader/Body/Footer */}
        <DialogContent size="lg">
          <ProductForm
            categories={categories}
            prefillBarcode={prefillBarcode ?? undefined}
            onSuccess={() => {
              setCreateOpen(false);
              setPrefillBarcode(null);
              fetchProducts();
              toast.success(t("products.created"), t("products.createdDesc"));
            }}
            onCancel={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Product Modal — ProductForm owns the dialog chrome */}
      <Dialog open={Boolean(editProduct)} onOpenChange={(open) => !open && setEditProduct(null)}>
        {/* eslint-disable-next-line @local/require-dialog-body -- ProductForm renders DialogHeader/Body/Footer */}
        <DialogContent size="lg">
          {editProduct && (
            <ProductForm
              initialData={{
                id: editProduct.id,
                name: editProduct.name,
                sku: editProduct.sku,
                barcode: editProduct.barcode ?? "",
                categoryId: editProduct.category.id,
                brandId: editProduct.brand?.id ?? "",
                unitPrice: editProduct.unitPrice / 100,
                costPrice: editProduct.costPrice / 100,
                taxRate: editProduct.taxRate ?? 0,
                status: editProduct.status as "active" | "inactive" | "discontinued",
                minStockLevel: editProduct.minStockLevel,
                trackInventory: editProduct.trackInventory ?? true,
                allowDiscount: editProduct.allowDiscount ?? true,
                unit: editProduct.unit ?? "pcs",
                allowFractional: editProduct.allowFractional ?? false,
                sellByValue: editProduct.sellByValue ?? false,
                images: parseProductImages(editProduct.images),
                unitConversions: parseUnitConversions(editProduct.unitConversions),
              }}
              categories={categories}
              onSuccess={() => {
                setEditProduct(null);
                fetchProducts();
                toast.success(t("products.updated"), t("common.savedDesc"));
              }}
              onCancel={() => setEditProduct(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={Boolean(deleteConfirm)} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("products.deleteProduct")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-neu-primary">
              {t("products.deleteConfirmPrefix")}{" "}
              <span className="font-semibold text-neu-primary">{deleteConfirm?.name}</span>?{" "}
              {t("products.deleteCannotUndo")}
            </p>
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              onClick={handleDelete}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Barcode Label Modal */}
      <Dialog open={Boolean(barcodeProduct)} onOpenChange={(open) => !open && setBarcodeProduct(null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("products.barcodeLabel")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {barcodeProduct && (
              <>
                <div className="flex items-center gap-3 rounded-lg bg-neu-sunken p-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-neu-sunken">
                    <svg className="h-6 w-6 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-neu-primary truncate">{barcodeProduct.name}</p>
                    <p className="text-xs text-neu-faint font-mono">{barcodeProduct.sku}</p>
                  </div>
                </div>
                <BarcodeLabel
                  productName={barcodeProduct.name}
                  sku={barcodeProduct.sku}
                  barcode={barcodeProduct.barcode}
                  price={barcodeProduct.unitPrice}
                  unit={barcodeProduct.unit}
                  size="lg"
                />
              </>
            )}
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setBarcodeProduct(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Price Adjustment Modal (bulk) */}
      <Dialog open={priceAdjOpen} onOpenChange={setPriceAdjOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("products.adjustPrices")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-sm text-neu-faint">
              {t("products.adjustPricesHint").replace("{n}", String(selected.size))}
            </p>
            <div className="pos-segmented w-full" role="group" aria-label={t("products.adjustMode")}>
              <button
                type="button"
                className="pos-segmented-btn h-9 flex-1"
                aria-pressed={priceAdjMode === "percent"}
                onClick={() => setPriceAdjMode("percent")}
              >
                {t("products.adjustPercent")}
              </button>
              <button
                type="button"
                className="pos-segmented-btn h-9 flex-1"
                aria-pressed={priceAdjMode === "amount"}
                onClick={() => setPriceAdjMode("amount")}
              >
                {t("products.adjustAmount")}
              </button>
            </div>
            <div>
              <label className="text-sm font-medium text-neu-primary">
                {priceAdjMode === "percent" ? t("products.adjustPercent") : t("common.amount")}
              </label>
              <input
                type="number"
                step={priceAdjMode === "percent" ? "1" : "0.01"}
                value={priceAdjValue}
                onChange={(e) => setPriceAdjValue(e.target.value)}
                placeholder={priceAdjMode === "percent" ? "10  =  +10%   −5  =  −5%" : "2.50"}
                className="mt-1.5 flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm tabular-nums dark:text-neu-muted neu-focus"
              />
              <p className="mt-1 text-xs text-neu-faint">{t("products.adjustNegativeHint")}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-neu-primary">{t("products.adjustApplyTo")}</label>
              <select
                className="mt-1.5 h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm dark:text-neu-muted neu-focus"
                value={priceAdjTarget}
                onChange={(e) => setPriceAdjTarget(e.target.value as typeof priceAdjTarget)}
              >
                <option value="unitPrice">{t("products.form.sellingPrice")}</option>
                <option value="costPrice">{t("products.form.costPrice")}</option>
                <option value="both">{t("products.adjustBoth")}</option>
              </select>
            </div>
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setPriceAdjOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={bulkUpdating}
              disabled={!priceAdjValue || isNaN(parseFloat(priceAdjValue))}
              onClick={async () => {
                const value = parseFloat(priceAdjValue);
                if (!Number.isFinite(value)) return;
                await bulkUpdate({ priceAdjust: { mode: priceAdjMode, value, applyTo: priceAdjTarget } });
                setPriceAdjOpen(false);
                setPriceAdjValue("");
              }}
            >
              {t("products.adjustApply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Barcode Label Sheet Modal (bulk printing) */}
      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("products.printBarcodes")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <BarcodeLabelSheet items={barcodeLabelSheetItems} />
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setSheetOpen(false)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Studio Modal — preview / replace / add-to-gallery.
          Uploads are normalized client-side first (auto-orient,
          ≤2048px, transparency-aware), so any uploaded shape or size
          ends up stored in a uniform, display-perfect form. */}
      <Dialog open={Boolean(imageUploadProduct)} onOpenChange={(open) => !open && setImageUploadProduct(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("products.uploadImage")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {imageUploadProduct && (
              <>
                <div className="text-center">
                  <button
                    type="button"
                    className="mx-auto block"
                    disabled={!imageUploadProduct.imageUrl}
                    title={imageUploadProduct.imageUrl ? t("products.zoomHint") : undefined}
                    onClick={() =>
                      setLightboxState({
                        images: [imageUploadProduct.imageUrl!],
                        index: 0,
                        alt: imageUploadProduct.name,
                      })
                    }
                  >
                    <SmartImage
                      src={imageUploadProduct.imageUrl}
                      alt={imageUploadProduct.name}
                      className="mx-auto h-32 w-32 rounded-lg border border-neu-hairline"
                      iconClassName="h-10 w-10"
                      zoomOnHover={false}
                    />
                  </button>
                  <p className="mt-2 text-sm text-neu-faint">{imageUploadProduct.name}</p>
                </div>
                <label className="block">
                  <span className="text-sm font-medium text-neu-primary">{t("products.chooseImage")}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="mt-1 block w-full text-sm text-neu-muted file:me-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-neu-accent-wash file:text-neu-accent-ink-strong"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || !imageUploadProduct) return;
                      e.target.value = "";
                      setUploading(true);
                      try {
                        let toSend = file;
                        try {
                          toSend = (await normalizeImageFile(file)).file;
                        } catch {
                          /* best-effort — upload the original */
                        }
                        const formData = new FormData();
                        formData.append("image", toSend);
                        const res = await fetch(`/api/products/${imageUploadProduct.id}/image`, {
                          method: "POST",
                          body: formData,
                        });
                        if (!res.ok) {
                          const data = await res.json();
                          toast.error(t("products.uploadFailed"), data.error || t("products.uploadRetry"));
                          return;
                        }
                        setImageUploadProduct(null);
                        fetchProducts();
                        toast.success(t("products.imageUploaded"), t("products.imageUpdated"));
                      } catch {
                        toast.error(t("products.uploadFailed"));
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>
                <p className="text-xs text-neu-faint">{t("products.imageFormatsHint")}</p>
              </>
            )}
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setImageUploadProduct(null)} disabled={uploading}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full-screen image preview (table rows / grid cards / modal) */}
      <ImageLightbox
        open={lightboxState !== null}
        onClose={() => setLightboxState(null)}
        images={lightboxState?.images ?? []}
        initialIndex={lightboxState?.index ?? 0}
        alt={lightboxState?.alt ?? ""}
      />

      {/* ═══ IMPORT RESULT DIALOG (stat cards + per-row errors) ═══ */}
      <ImportResultDialog
        open={resultOpen}
        onClose={() => setResultOpen(false)}
        result={importResult}
        entityLabel="products"
      />
    </div>
  );
}
