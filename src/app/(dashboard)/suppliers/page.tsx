"use client";

import * as React from "react";
import { centsToMajorString } from "@/lib/money/money";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { readApiError } from "@/lib/api/api-error";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/stores/toast-store";
import { cn, formatCurrency } from "@/lib/utils";
import { downloadCsv } from "@/lib/files/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { ImportResultDialog, type ImportSummary } from "@/components/import/import-result-dialog";
import { fetchReportSettings, printReport } from "@/lib/print/print-report";
import { SortableTh } from "@/components/ui/sortable-th";
import { useTableRowNav } from "@/hooks/use-table-row-nav";

/* ═══════════════════════════════════════════════════════════════
   SUPPLIERS PAGE
   Full CRUD for suppliers with performance metrics.
   ═══════════════════════════════════════════════════════════════ */

interface Supplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  paymentTerms: number;
  rating: number;
  isActive: boolean;
  stats: { totalSpent: number; totalOrders: number; rating: number };
  _count: { products: number; purchaseOrders: number };
}

interface SupplierForm {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  taxId: string;
  paymentTerms: number;
  rating: number;
  notes: string;
}

const EMPTY_FORM: SupplierForm = {
  name: "", email: "", phone: "", address: "", city: "", country: "",
  taxId: "", paymentTerms: 30, rating: 0, notes: "",
};

/* The star glyph `★` was the app's last text-symbol icon. It is now an inline
   SVG (the project's only icon vocabulary), which also gives it a real size
   and the amber INK role — a rating is read, and the vivid accent amber is
   1.80:1 on the light surface. */
function StarIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("shrink-0", filled ? "text-neu-ink-amber" : "text-neu-faint", className)}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L4.52 20.424a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.32-.988l5.519-.442a.563.563 0 00.475-.345L11.48 3.5z" />
    </svg>
  );
}

export default function SuppliersPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t, dir } = useI18n();
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);

  // Keyboard row navigation (roving tabindex + arrows/type-ahead); Enter
  // opens the same detail dialog a click does. Index maps 1:1 to the
  // rendered rows, which follow the (server-sorted) array order.
  const tbodyRef = useTableRowNav<HTMLTableSectionElement>((i) => {
    const s = suppliers[i];
    if (s) setShowDetail(s);
  });

  // Server-side sort in the shared "field.order" wire format — the API
  // clamps it to its allow-list, so a hand-edited query can never throw
  // inside Prisma's orderBy. Names read best A→Z; numeric columns open
  // high→low.
  const [sort, setSort] = React.useState("name.asc");
  function toggleSort(field: string) {
    setSort((s) => {
      if (s.startsWith(`${field}.`)) {
        return `${field}.${s.endsWith(".asc") ? "desc" : "asc"}`;
      }
      return `${field}.${field === "name" ? "asc" : "desc"}`;
    });
  }

  // CSV export/import (export state lives inside ExportMenu)

  // CSV import
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState<ImportSummary | null>(null);
  const [resultOpen, setResultOpen] = React.useState(false);
  const importInputRef = React.useRef<HTMLInputElement>(null);

  const SUPPLIER_CSV_HEADERS = [
    "name", "email", "phone", "address", "city", "country", "taxId", "paymentTerms", "rating", "notes",
  ];

  // Import suppliers from CSV
  async function handleImportCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/suppliers/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("common.importFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      fetchSuppliers();
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

  // Fetch all suppliers for export (search-aware)
  const fetchAllSuppliers = React.useCallback(async (): Promise<Supplier[]> => {
    const params = new URLSearchParams({ limit: "10000" });
    if (search) params.set("search", search);
    const res = await fetch(`/api/suppliers?${params}`);
    const data = await res.json();
    return data.suppliers ?? [];
  }, [search]);

  // Elite shared export columns — one config drives CSV, Excel and print.
  const supplierExportColumns: ExportColumn<Supplier>[] = [
    { header: "name", value: (s) => s.name, print: { strong: true } },
    { header: "email", value: (s) => s.email ?? "", print: { muted: true } },
    { header: "phone", value: (s) => s.phone ?? "" },
    { header: "city", value: (s) => s.city ?? "" },
    { header: "country", value: (s) => s.country ?? "", omitPrint: true },
    { header: "paymentTerms", value: (s) => String(s.paymentTerms), excelStyle: "int", print: { label: "Terms (days)", align: "right" } },
    { header: "rating", value: (s) => String(s.rating ?? 0), excelStyle: "int", print: { align: "center" } },
    { header: "products", value: (s) => String(s._count?.products ?? 0), excelStyle: "int", print: { align: "right" } },
    {
      header: "totalSpent",
      value: (s) => centsToMajorString(s.stats?.totalSpent ?? 0),
      excelStyle: "money",
      print: { align: "right", strong: true, total: (rows) => formatCurrency(rows.reduce((a, r) => a + (r.stats?.totalSpent ?? 0), 0)) },
    },
  ];

  const exportCSV = async () => {
    try {
      const all = await fetchAllSuppliers();
      downloadCsv(
        "suppliers",
        supplierExportColumns.map((c) => c.header),
        all.map((s) => supplierExportColumns.map((c) => c.value(s)))
      );
      toast.success(t("common.exportStarted"), `${all.length} ${t("suppliers.count")}`);
    } catch {
      toast.error(t("common.exportFailed"), t("common.exportFailedDesc"));
    }
  };

  // Printed A4 supplier directory via the shared report engine
  const printSuppliers = async () => {
    const all = await fetchAllSuppliers();
    const settings = await fetchReportSettings(t("app.name"));
    printReport(
      {
        title: t("suppliers.title"),
        kicker: "Supplier Directory",
        kpis: [
          { label: t("suppliers.count"), value: String(all.length) },
          { label: t("suppliers.totalSpent"), value: formatCurrency(all.reduce((a, s) => a + (s.stats?.totalSpent ?? 0), 0)), tone: "positive" },
        ],
        columns: supplierExportColumns.map((c) => ({
          label: c.print?.label ?? c.header,
          align: c.print?.align,
          width: c.print?.width,
          strong: c.print?.strong,
          muted: c.print?.muted,
          value: (row: Supplier) => String(c.value(row) ?? ""),
          total: c.print?.total,
        })),
        rows: all,
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => toast.error(t("common.printBlocked"), t("common.allowPopups")) }
    );
  };

  // Modals
  const [showForm, setShowForm] = React.useState(false);
  const [editing, setEditing] = React.useState<Supplier | null>(null);
  const [showDetail, setShowDetail] = React.useState<Supplier | null>(null);
  const [form, setForm] = React.useState<SupplierForm>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [deleting, setDeleting] = React.useState<Supplier | null>(null);

  function clearFieldError(field: string) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  const fetchSuppliers = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (search) params.set("search", search);
      params.set("sort", sort);
      const res = await fetch(`/api/suppliers?${params}`);
      const data = await res.json();
      setSuppliers(data.suppliers ?? []);
      setTotalPages(data.pagination?.totalPages ?? 1);
    } catch { setLoadError(true); }
    setLoading(false);
  }, [page, search, sort]);

  React.useEffect(() => { fetchSuppliers(); }, [fetchSuppliers]);

  React.useEffect(() => {
    const timer = setTimeout(() => setPage(1), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // A new sort goes back to page 1.
  React.useEffect(() => { setPage(1); }, [sort]);

  function openCreate() { setEditing(null); setForm(EMPTY_FORM); setFieldErrors({}); setShowForm(true); }
  function openEdit(s: Supplier) {
    setEditing(s);
    setForm({
      name: s.name, email: s.email || "", phone: s.phone || "",
      address: s.address || "", city: s.city || "", country: s.country || "",
      taxId: "", paymentTerms: s.paymentTerms, rating: s.rating, notes: "",
    });
    setFieldErrors({});
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim() || saving) return; // saving guard blocks double-submit
    setSaving(true);
    try {
      const url = editing ? `/api/suppliers/${editing.id}` : "/api/suppliers";
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const { fields, message } = await readApiError(res, t("common.saveFailed"));
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else toast.error(message);
        return;
      }
      setShowForm(false);
      fetchSuppliers();
      toast.success(editing ? t("suppliers.updated") : t("suppliers.created"));
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await fetch(`/api/suppliers/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      fetchSuppliers();
      toast.success(t("suppliers.deleted"));
    } catch { /* ignore */ }
  }

  /* Inline SVG, not a `★` glyph: the app draws every icon as an <svg>, and a
     text glyph inside a table cell also inherits the row's baseline and font
     metrics. Filled stars use the amber INK role — a rating is read, and the
     vivid accent amber is 1.80:1. */
  function renderStars(rating: number) {
    return Array.from({ length: 5 }, (_, i) => (
      <StarIcon key={i} filled={i < Math.round(rating)} className="h-4 w-4" />
    ));
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={t("suppliers.title")}
        description={`${suppliers.length} ${t("suppliers.count")}`}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("suppliers.title") },
        ]}
        actions={
          <>
          <ExportMenu<Supplier>
            fileStem="suppliers"
            sheetName="Suppliers"
            rows={suppliers}
            columns={supplierExportColumns}
            template={{ headers: SUPPLIER_CSV_HEADERS, exampleRows: [
              ["Fresh Foods Ltd", "orders@freshfoods.example", "+92 300 1234567", "12 Industrial Ave", "Karachi", "Pakistan", "1234567-8", "30", "4", "Weekly dairy deliveries"],
              ["Grain Co", "sales@grainco.example", "+92 321 7654321", "5 Mill Road", "Lahore", "Pakistan", "", "45", "3", "Bulk grains, 45-day terms"],
            ] }}
            customItems={[{ label: t("export.fetchAllThenCsv"), icon: "csv", onSelect: exportCSV }]}
            printKpis={[
              { label: t("suppliers.count"), value: String(suppliers.length) },
              { label: t("suppliers.totalSpent"), value: formatCurrency(suppliers.reduce((a, s) => a + (s.stats?.totalSpent ?? 0), 0)), tone: "positive" },
            ]}
            onPrint={printSuppliers}
            disabled={suppliers.length === 0}
          />
          <Button variant="secondary" loading={importing} onClick={() => importInputRef.current?.click()}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            {t("common.import")}
          </Button>
          <input ref={importInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCSV} />
          <Button onClick={openCreate}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t("suppliers.addSupplier")}
          </Button>
          </>
        }
      />

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <svg className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("suppliers.search")}
            className="h-10 w-full rounded-lg border border-neu-hairline bg-neu-bg ps-10 pe-4 text-sm text-neu-primary placeholder:text-neu-faint transition-colors neu-focus"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-neu-hairline bg-neu-bg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neu-hairline bg-neu-sunken">
                <SortableTh label={t("suppliers.name")} active={sort.startsWith("name.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("name")} />
                <th className="text-start px-4 py-3 font-medium text-neu-muted hidden md:table-cell">{t("suppliers.email")}</th>
                <th className="text-start px-4 py-3 font-medium text-neu-muted hidden lg:table-cell">{t("suppliers.phone")}</th>
                <SortableTh label={t("suppliers.rating")} align="center" active={sort.startsWith("rating.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("rating")} />
                <SortableTh label={t("suppliers.products")} align="center" className="hidden sm:table-cell" active={sort.startsWith("products.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("products")} />
                <SortableTh label={t("suppliers.purchaseOrders")} align="center" className="hidden md:table-cell" active={sort.startsWith("purchaseOrders.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("purchaseOrders")} />
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
                        <Button variant="secondary" size="sm" onClick={fetchSuppliers}>
                          {t("common.retry")}
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ) : suppliers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-0">
                    <EmptyState
                      bare
                      icon={
                        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
                        </svg>
                      }
                      title={t("suppliers.noSuppliers")}
                      description={t("suppliers.noSuppliersHint")}
                    />
                  </td>
                </tr>
              ) : (
                suppliers.map((s) => (
                  <tr key={s.id} data-nav-row data-nav-label={s.name} className="hover:bg-neu-sunken transition-colors cursor-pointer" onClick={() => setShowDetail(s)}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neu-accent-wash text-sm font-semibold text-neu-accent-ink-strong">
                          {s.name.charAt(0)}
                        </div>
                        <div>
                          <p className="font-medium text-neu-primary">{s.name}</p>
                          {s.city && <p className="text-xs text-neu-faint">{s.city}{s.country ? `, ${s.country}` : ""}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-neu-muted hidden md:table-cell">{s.email || "—"}</td>
                    <td className="px-4 py-3 text-neu-muted hidden lg:table-cell">{s.phone || "—"}</td>
                    <td className="px-4 py-3 text-center"><div className="flex justify-center">{renderStars(s.rating)}</div></td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      <Badge variant="info">{s._count.products}</Badge>
                    </td>
                    <td className="px-4 py-3 text-center hidden md:table-cell">
                      <Badge variant="success">{s._count.purchaseOrders}</Badge>
                    </td>
                    <td className="px-4 py-3 text-end" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(s)} title={t("common.edit")}>
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                          </svg>
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(s)} title={t("common.delete")} className="text-neu-ink-red hover:bg-neu-wash-red">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
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
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-neu-hairline px-4 py-3">
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t("common.previous")}
            </Button>
            <span className="text-sm text-neu-faint">{t("common.page")} {page} {t("common.of")} {totalPages}</span>
            <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              {t("common.next")}
            </Button>
          </div>
        )}
      </div>

      {/* ═══ CREATE/EDIT MODAL ═══ */}
      <Dialog open={showForm} onOpenChange={(o) => !o && setShowForm(false)}>
        {/* Shared DialogContent, not a hand-rolled overlay: it owns the dvh
            clamp, the single scroll region, the focus trap and the ARIA
            wiring. The form WRAPS header/body/footer so the submit button
            still submits while DialogBody stays the only thing that scrolls. */}
        <DialogContent size="lg">
          <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader>
              <DialogTitle>{editing ? t("suppliers.editSupplier") : t("suppliers.addSupplier")}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <Input
                label={`${t("suppliers.name")} *`}
                value={form.name}
                error={fieldErrors["name"]}
                onChange={(e) => { setForm({ ...form, name: e.target.value }); clearFieldError("name"); }}
              />
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("suppliers.email")}
                  type="email"
                  value={form.email}
                  error={fieldErrors["email"]}
                  onChange={(e) => { setForm({ ...form, email: e.target.value }); clearFieldError("email"); }}
                />
                <div>
                  <label className="block text-sm font-medium text-neu-primary mb-1">{t("suppliers.phone")}</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="h-10 w-full rounded-lg border border-neu-hairline px-3 text-sm neu-focus" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neu-primary mb-1">{t("suppliers.paymentTerms")} ({t("suppliers.days")})</label>
                <input type="number" value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: parseInt(e.target.value) || 30 })}
                  className="h-10 w-full rounded-lg border border-neu-hairline px-3 text-sm neu-focus" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neu-primary mb-1">{t("suppliers.city")}</label>
                  <input type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}
                    className="h-10 w-full rounded-lg border border-neu-hairline px-3 text-sm neu-focus" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neu-primary mb-1">{t("suppliers.country")}</label>
                  <input type="text" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}
                    className="h-10 w-full rounded-lg border border-neu-hairline px-3 text-sm neu-focus" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neu-primary mb-1">{t("suppliers.ratingLabel")}</label>
                {/* A rating is a single-choice control, so each star is a
                    toggle button: it needs a name (the glyph had none) and
                    `aria-pressed`, which is the only thing that tells a screen
                    reader which value is currently set. */}
                <div className="flex gap-1" role="group" aria-label={t("suppliers.ratingLabel")}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setForm({ ...form, rating: star })}
                      aria-pressed={star <= form.rating}
                      aria-label={`${star} / 5`}
                      className="neu-focus rounded-md p-0.5 transition-colors hover:bg-neu-sunken"
                    >
                      <StarIcon filled={star <= form.rating} className="h-6 w-6" />
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neu-primary mb-1">{t("suppliers.notes")}</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3}
                  className="w-full rounded-lg border border-neu-hairline px-3 py-2 text-sm resize-none neu-focus" />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setShowForm(false)}>{t("common.cancel")}</Button>
              <Button type="submit" loading={saving}>{t("common.save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ═══ DETAIL MODAL ═══ */}
      <Dialog open={Boolean(showDetail)} onOpenChange={(o) => !o && setShowDetail(null)}>
        <DialogContent size="lg" height="tall">
          <DialogHeader>
            <DialogTitle>{showDetail?.name}</DialogTitle>
          </DialogHeader>
          {showDetail && (
            <DialogBody className="space-y-4">
              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-neu-sunken p-3 text-center">
                  <p className="text-2xl font-bold text-neu-primary">{showDetail._count.products}</p>
                  <p className="text-xs text-neu-faint">{t("suppliers.products")}</p>
                </div>
                <div className="rounded-lg bg-neu-sunken p-3 text-center">
                  <p className="text-2xl font-bold text-neu-primary">{showDetail._count.purchaseOrders}</p>
                  <p className="text-xs text-neu-faint">{t("suppliers.purchaseOrders")}</p>
                </div>
                <div className="rounded-lg bg-neu-sunken p-3 text-center">
                  <p className="text-2xl font-bold text-neu-primary">{formatCurrency(showDetail.stats.totalSpent)}</p>
                  <p className="text-xs text-neu-faint">{t("suppliers.totalSpent")}</p>
                </div>
              </div>
              {/* Details */}
              <div className="space-y-2 text-sm">
                {showDetail.email && <div className="flex justify-between"><span className="text-neu-faint">{t("suppliers.email")}</span><span className="text-neu-primary">{showDetail.email}</span></div>}
                {showDetail.phone && <div className="flex justify-between"><span className="text-neu-faint">{t("suppliers.phone")}</span><span className="text-neu-primary">{showDetail.phone}</span></div>}
                {showDetail.address && <div className="flex justify-between"><span className="text-neu-faint">{t("suppliers.addressLabel")}</span><span className="text-neu-primary">{showDetail.address}</span></div>}
                {showDetail.city && <div className="flex justify-between"><span className="text-neu-faint">{t("suppliers.city")}</span><span className="text-neu-primary">{showDetail.city}</span></div>}
                {showDetail.country && <div className="flex justify-between"><span className="text-neu-faint">{t("suppliers.country")}</span><span className="text-neu-primary">{showDetail.country}</span></div>}
                <div className="flex justify-between"><span className="text-neu-faint">{t("suppliers.paymentTerms")}</span><span className="text-neu-primary">{showDetail.paymentTerms} {t("suppliers.days")}</span></div>
                <div className="flex justify-between"><span className="text-neu-faint">{t("suppliers.rating")}</span><div className="flex">{renderStars(showDetail.rating)}</div></div>
              </div>
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>

      {/* ═══ DELETE CONFIRM ═══ */}
      <Dialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent size="sm">
          <DialogBody className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neu-red/15">
              <svg className="h-6 w-6 text-neu-ink-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold">{t("common.delete")} {deleting?.name}?</h3>
            <p className="text-sm text-neu-faint">{t("suppliers.deleteHint")}</p>
          </DialogBody>
          <DialogFooter className="gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" className="flex-1" onClick={handleDelete}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ IMPORT RESULT ═══ */}
      <ImportResultDialog
        open={resultOpen}
        onClose={() => setResultOpen(false)}
        result={importResult}
        entityLabel={t("suppliers.title")}
      />
    </div>
  );
}
