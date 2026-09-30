"use client";

import * as React from "react";
import { formatCurrency, formatDate, formatNumber, cn, getInitials } from "@/lib/utils";
import { downloadCsv } from "@/lib/csv";
import { ExportMenu, type ExportColumn } from "@/components/export/export-menu";
import { ImportResultDialog, type ImportSummary } from "@/components/import/import-result-dialog";
import { displayMajorToBaseCents, baseCentsToDisplayMajorStr } from "@/lib/currency-core";
import { ensureRates, peekRates } from "@/lib/currency";
import { printCustomerStatement } from "@/lib/print-customer-statement";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { SortableTh } from "@/components/ui/sortable-th";
import { useTableRowNav } from "@/hooks/use-table-row-nav";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/stores/toast-store";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* ═══════════════════════════════════════════════════════════════
   CUSTOMERS PAGE
   Full customer management with CRUD, loyalty tracking,
   purchase history, and customer detail view.
   ═══════════════════════════════════════════════════════════════ */

interface Customer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  taxId?: string;
  notes?: string;
  loyaltyPoints: number;
  totalSpent: number;
  /** Cents the customer still owes (khata/credit). */
  outstandingBalance: number;
  orderCount: number;
  isActive: boolean;
  createdAt: string;
  _count?: { orders: number };
}

interface CustomerDetail extends Customer {
  calculatedTotalSpent: number;
  recentOrderCount: number;
  creditOrderCount?: number;
  openCreditOrders?: Array<{
    id: string;
    orderNumber: string;
    total: number;
    paidAmount: number;
    dueAmount: number;
    paymentStatus: string;
    createdAt: string;
  }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    total: number;
    status: string;
    createdAt: string;
    items: Array<{ productName: string; quantity: number; total: number }>;
  }>;
}

/** Compact loyalty chip used in the table + mobile cards. */
function LoyaltyChip({ points }: { points: number }) {
  const tier = points >= 200;
  return (
    <Badge variant={tier ? "success" : "default"} size="sm" className="gap-1 tabular-nums">
      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
        />
      </svg>
      {formatNumber(points)}
    </Badge>
  );
}

/** Minimum customer shape the collect/statement flows need. The
 *  receivables worklist only carries a summary row, so these flows must
 *  not require the full Customer (which previously forced a lookup in the
 *  current page array and silently no-op'd for off-page customers). */
type PayableCustomer = Pick<Customer, "id" | "name"> & Partial<Customer>;

export default function CustomersPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  useStoreCurrency();
  const { t } = useI18n();
  const [customers, setCustomers] = React.useState<Customer[]>([]);

  // Keyboard row navigation — Enter opens the customer detail (same as a
  // row click); index maps to the rendered (server-sorted) row order.
  const tbodyRef = useTableRowNav<HTMLTableSectionElement>((i) => {
    const c = customers[i];
    if (c) viewDetail(c);
  });
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [hasNext, setHasNext] = React.useState(false);

  // Sorting (server-side via /api/customers sortBy/sortOrder)
  const [sortBy, setSortBy] = React.useState("createdAt");
  const [sortOrder, setSortOrder] = React.useState<"asc" | "desc">("desc");
  function toggleSort(field: string) {
    if (sortBy === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      // Names read best A→Z; numeric money/date columns read best high→low.
      setSortOrder(field === "name" ? "asc" : "desc");
    }
  }

  // CSV export/import
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState<ImportSummary | null>(null);
  const [resultOpen, setResultOpen] = React.useState(false);
  const custImportInputRef = React.useRef<HTMLInputElement>(null);

  // Import customers from CSV
  async function handleImportCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/customers/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("common.importFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      fetchCustomers();
      // Elite result dialog: stat cards + per-row errors + error CSV
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
      if (custImportInputRef.current) custImportInputRef.current.value = "";
    }
  }

  // Elite shared export columns (CSV + Excel + Print from one config)
  const customerExportColumns: ExportColumn<Customer>[] = [
    { header: "name", value: (c) => c.name },
    { header: "email", value: (c) => c.email ?? "" },
    { header: "phone", value: (c) => c.phone ?? "" },
    { header: "address", value: (c) => c.address ?? "" },
    { header: "loyaltyPoints", value: (c) => c.loyaltyPoints, excelStyle: "int", print: { align: "right" } },
    {
      header: "totalSpent", value: (c) => (c.totalSpent / 100).toFixed(2), excelStyle: "money", print: { align: "right", total: (rows) => formatCurrency(rows.reduce((s, r) => s + (r.totalSpent ?? 0), 0)) },
    },
    { header: "orders", value: (c) => c.orderCount ?? c._count?.orders ?? 0, excelStyle: "int", print: { align: "right" } },
    { header: "since", value: (c) => new Date(c.createdAt).toISOString().split("T")[0], print: { align: "right" } },
  ];

  // Full export dataset (all rows, not just the current page) —
  // loaded once so the ExportMenu can offer CSV/Excel/Print instantly
  // AND so the KPI strip shows true totals rather than a page slice.
  const [allCustomers, setAllCustomers] = React.useState<Customer[]>([]);
  const [allLoading, setAllLoading] = React.useState(true);
  const fetchAllCustomers = React.useCallback(async () => {
    setAllLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: "10000", sortBy: "createdAt", sortOrder: "desc" });
      if (search) params.set("search", search);
      const res = await fetch(`/api/customers?${params}`);
      const data = await res.json();
      setAllCustomers((data.items ?? []) as Customer[]);
    } catch {
      /* export dataset is best-effort */
    } finally {
      setAllLoading(false);
    }
  }, [search]);
  React.useEffect(() => { fetchAllCustomers(); }, [fetchAllCustomers]);

  // Modal states
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editCustomer, setEditCustomer] = React.useState<Customer | null>(null);
  const [detailCustomer, setDetailCustomer] = React.useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState<Customer | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // ── Receivables (khata) panel data ──────────────────────────────
  interface ReceivableCustomer {
    customerId: string;
    name: string;
    phone: string | null;
    total: number;
    orders: number;
    oldestDays: number;
  }
  const [receivables, setReceivables] = React.useState<{
    total: number;
    customers: ReceivableCustomer[];
    buckets: { b0_30: number; b31_60: number; b61_90: number; b90plus: number };
    orderCount: number;
  } | null>(null);
  const [showReceivables, setShowReceivables] = React.useState(false);

  const fetchReceivables = React.useCallback(async () => {
    try {
      const res = await fetch("/api/reports/receivables");
      if (!res.ok) return;
      setReceivables(await res.json());
    } catch {
      /* panel is supplementary — stay silent */
    }
  }, []);

  // Form state
  const [formName, setFormName] = React.useState("");
  const [formEmail, setFormEmail] = React.useState("");
  const [formPhone, setFormPhone] = React.useState("");
  const [formAddress, setFormAddress] = React.useState("");
  const [formNotes, setFormNotes] = React.useState("");
  const [formLoading, setFormLoading] = React.useState(false);
  const [formErrors, setFormErrors] = React.useState<Record<string, string[]>>({});

  // Guards against out-of-order responses: a slow earlier request (e.g. the
  // previous search term) must never overwrite the latest page.
  const customersReq = React.useRef(0);

  // Fetch customers (server paging + sorting)
  const fetchCustomers = React.useCallback(async () => {
    const reqId = ++customersReq.current;
    setLoading(true);
    setLoadError(false);
    const params = new URLSearchParams({ page: String(page), pageSize: "15", sortBy, sortOrder });
    if (search) params.set("search", search);
    try {
      const res = await fetch(`/api/customers?${params}`);
      const data = await res.json();
      if (reqId !== customersReq.current) return; // stale response — drop it
      setCustomers(data.items ?? []);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setHasNext(data.hasNext);
    } catch (e) { console.error(e); setLoadError(true); }
    finally { if (reqId === customersReq.current) setLoading(false); }
  }, [page, search, sortBy, sortOrder]);

  React.useEffect(() => { fetchCustomers(); }, [fetchCustomers]);
  React.useEffect(() => { setPage(1); }, [search, sortBy, sortOrder]);
  React.useEffect(() => { fetchReceivables(); }, [fetchReceivables]);

  // Debounced search
  const [searchInput, setSearchInput] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset form
  function resetForm() {
    setFormName(""); setFormEmail(""); setFormPhone("");
    setFormAddress(""); setFormNotes(""); setFormErrors({});
  }

  // Create or update customer
  async function handleSave() {
    if (formLoading) return; // guard blocks double-submit
    setFormLoading(true);
    setFormErrors({});
    try {
      const body = {
        name: formName, email: formEmail || undefined,
        phone: formPhone || undefined, address: formAddress || undefined,
        notes: formNotes || undefined,
      };
      const isEdit = Boolean(editCustomer);
      const url = isEdit ? `/api/customers/${editCustomer!.id}` : "/api/customers";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormErrors(typeof data.error === "object" ? data.error : { _form: [data.error] });
        return;
      }
      setCreateOpen(false);
      setEditCustomer(null);
      resetForm();
      fetchCustomers();
      toast.success(isEdit ? t("customers.updated") : t("customers.added"));
    } catch { setFormErrors({ _form: [t("common.networkError")] }); }
    finally { setFormLoading(false); }
  }

  // ── Receive payment against outstanding dues (khata settlement) ──
  const [payCustomer, setPayCustomer] = React.useState<PayableCustomer | null>(null);
  const [payAmount, setPayAmount] = React.useState("");
  const [payMethod, setPayMethod] = React.useState("cash");
  const [payNotes, setPayNotes] = React.useState("");
  const [payLoading, setPayLoading] = React.useState(false);

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

  function openReceivePayment(c: PayableCustomer) {
    setPayCustomer(c);
    // Prefill in the currency the user SEES (converted when active).
    setPayAmount(baseCentsToDisplayMajorStr(c.outstandingBalance ?? 0, fx));
    setPayMethod("cash");
    setPayNotes("");
  }

  async function submitPayment() {
    if (!payCustomer || payLoading) return; // guard blocks double-submit
    // Typed in the display currency → base cents (identity when unconverted).
    const cents = displayMajorToBaseCents(parseFloat(payAmount) || 0, fx);
    if (cents <= 0) {
      toast.error(t("customers.paymentInvalidAmount"));
      return;
    }
    setPayLoading(true);
    try {
      const res = await fetch(`/api/customers/${payCustomer.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: cents, method: payMethod, notes: payNotes || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("customers.paymentFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      toast.success(
        t("customers.paymentSuccess"),
        `${t("customers.paymentApplied")}: ${formatCurrency(data.appliedTotal ?? 0)} · ${t("customers.ordersSettled")}: ${data.ordersSettled ?? 0}`
      );
      setPayCustomer(null);
      fetchCustomers();
      fetchReceivables();
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setPayLoading(false);
    }
  }

  // Store identity for the printed statement header.
  const [storeReceipt, setStoreReceipt] = React.useState({
    storeName: "",
    storeAddress: "",
    storePhone: "",
  });
  React.useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings;
        if (!s) return;
        setStoreReceipt({
          storeName: s.storeName ?? "",
          storeAddress: s.storeAddress ?? "",
          storePhone: s.storePhone ?? "",
        });
      })
      .catch(() => {});
  }, []);

  // View customer detail
  async function viewDetail(customer: Customer) {
    setDetailLoading(true);
    setDetailCustomer(customer as CustomerDetail);
    try {
      const res = await fetch(`/api/customers/${customer.id}`);
      const data = await res.json();
      setDetailCustomer(data.customer);
    } catch (e) { console.error(e); }
    finally { setDetailLoading(false); }
  }

  // Print a khata ledger/statement for this customer.
  async function printStatement(customer: { id: string }) {
    try {
      const res = await fetch(`/api/customers/${customer.id}/statement`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("customers.statementFailed"));
        return;
      }
      printCustomerStatement(data, {
        storeName: storeReceipt.storeName || t("app.name"),
        storeAddress: storeReceipt.storeAddress || undefined,
        storePhone: storeReceipt.storePhone || undefined,
      });
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    }
  }

  // Delete customer
  async function handleDelete() {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await fetch(`/api/customers/${deleteConfirm.id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      fetchCustomers();
      fetchReceivables();
      toast.success(t("customers.removed"), t("customers.removeConfirmNote"));
    } catch (e) { console.error(e); toast.error(t("customers.removeFailed")); }
    finally { setDeleting(false); }
  }

  // Open edit form
  function openEdit(customer: Customer) {
    setEditCustomer(customer);
    setFormName(customer.name);
    setFormEmail(customer.email ?? "");
    setFormPhone(customer.phone ?? "");
    setFormAddress(customer.address ?? "");
    setFormNotes(customer.notes ?? "");
    setFormErrors({});
    setCreateOpen(true);
  }

  // Open create form
  function openCreate() {
    setEditCustomer(null);
    resetForm();
    setCreateOpen(true);
  }

  // KPI aggregates from the FULL dataset (falls back to the page slice if the
  // full fetch failed). These used to sum only the visible page, so the
  // loyalty/revenue/dues cards were misleading on multi-page stores.
  const statsSource = allCustomers.length > 0 ? allCustomers : customers;
  const statsLoading = allLoading && total > 0;
  const totalLoyalty = statsSource.reduce((s, c) => s + c.loyaltyPoints, 0);
  const totalRevenue = statsSource.reduce((s, c) => s + c.totalSpent, 0);
  const totalOutstanding = statsSource.reduce((s, c) => s + (c.outstandingBalance ?? 0), 0);
  const hasSearch = Boolean(search);

  // Shared empty state for the table + mobile list.
  const emptyStateNode = (
    <EmptyState
      bare
      icon={
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
      }
      title={hasSearch ? t("customers.noMatch") : t("customers.empty")}
      description={hasSearch ? t("common.noMatchHint") : t("customers.emptyHint")}
      action={
        hasSearch ? (
          <Button variant="secondary" size="sm" onClick={() => { setSearchInput(""); setSearch(""); }}>
            {t("common.clearFilters")}
          </Button>
        ) : (
          <Button size="sm" onClick={openCreate}>
            {t("customers.addCustomer")}
          </Button>
        )
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
        <Button variant="secondary" size="sm" onClick={fetchCustomers}>
          {t("common.retry")}
        </Button>
      }
    />
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("customers.title")}
        description={`${total} ${t("customers.inDatabase")}`}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("customers.title") },
        ]}
        actions={
          <>
            <ExportMenu<Customer>
              fileStem="customers"
              sheetName="Customers"
              rows={allCustomers}
              columns={customerExportColumns}
              disabled={total === 0}
              printKpis={[
                { label: t("customers.totalCount"), value: String(total) },
                { label: t("customers.totalOutstanding"), value: formatCurrency(allCustomers.reduce((s, c) => s + (c.outstandingBalance ?? 0), 0)), tone: "warning" },
              ]}
              customItems={[
                {
                  label: t("export.template"),
                  icon: "template",
                  onSelect: () =>
                    downloadCsv(`customers-template`, ["name", "email", "phone", "address", "taxId", "notes"], [
                      ["Ahmed Ali", "ahmed@example.com", "03001234567", "Lahore", "", "Walk-in khata customer"],
                      ["Fatima Khan", "fatima@example.com", "03007654321", "Karachi", "", ""],
                    ]),
                },
              ]}
            />
            <Button variant="secondary" loading={importing} onClick={() => custImportInputRef.current?.click()}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              {t("common.import")}
            </Button>
            <input ref={custImportInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCSV} />
            <Button onClick={openCreate}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
            </svg>
            {t("customers.addCustomer")}
          </Button>
          </>
        }
      />

      {/* KPI strip — aggregates over the whole (filtered) customer base */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statsLoading ? (
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
            <StatCard label={t("customers.totalCount")} value={formatNumber(total)} icon="users" tone="brand" />
            <StatCard label={t("customers.totalLoyalty")} value={formatNumber(totalLoyalty)} icon="star" tone="warning" />
            <StatCard label={t("customers.totalRevenue")} value={formatCurrency(totalRevenue)} icon="cash" tone="success" />
            <StatCard label={t("customers.totalOutstanding")} value={formatCurrency(totalOutstanding)} icon="wallet" tone="warning" />
          </>
        )}
      </div>

      {/* ═══ RECEIVABLES (KHATA) PANEL ═══ */}
      {receivables && receivables.total > 0 && (
        <Card>
          <CardContent className="p-4">
            <button
              type="button"
              className="flex w-full items-center justify-between"
              onClick={() => setShowReceivables((v) => !v)}
              aria-expanded={showReceivables}
            >
              <div className="flex items-center gap-2">
                <svg className={cn("h-4 w-4 text-neu-ink-amber transition-transform", showReceivables && "rotate-90")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <span className="text-sm font-semibold text-neu-primary">{t("customers.receivablesTitle")}</span>
                <Badge variant="warning" size="sm">{receivables.customers.length}</Badge>
              </div>
              <span className="text-base font-bold tabular-nums text-neu-ink-amber">{formatCurrency(receivables.total)}</span>
            </button>
            {showReceivables && (
              <div className="mt-3 space-y-3">
                {/* Aging summary */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { label: t("customers.aging0_30"), value: receivables.buckets.b0_30, tone: "text-neu-primary" },
                    { label: t("customers.aging31_60"), value: receivables.buckets.b31_60, tone: "text-neu-ink-amber" },
                    { label: t("customers.aging61_90"), value: receivables.buckets.b61_90, tone: "text-neu-ink-amber" },
                    { label: t("customers.aging90plus"), value: receivables.buckets.b90plus, tone: "text-neu-ink-red" },
                  ].map((b) => (
                    <div key={b.label} className="rounded-lg bg-neu-sunken p-2.5">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-neu-faint">{b.label}</p>
                      <p className={cn("text-sm font-bold tabular-nums", b.tone)}>{formatCurrency(b.value)}</p>
                    </div>
                  ))}
                </div>
                {/* Worklist — most owed first, oldest debt flagged */}
                <div className="divide-y divide-neu-hairline rounded-lg border border-neu-hairline">
                  {receivables.customers.slice(0, 8).map((c) => (
                    <div key={c.customerId} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neu-primary">{c.name}</p>
                        <p className="text-[11px] text-neu-faint">
                          {c.orders} {t("customers.creditOrdersCount")}
                          {c.oldestDays > 60 ? ` · ${t("customers.oldestDebt").replace("{days}", String(c.oldestDays))}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-bold tabular-nums text-neu-ink-amber">{formatCurrency(c.total)}</span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t("customers.printStatement")}
                          aria-label={t("customers.printStatement")}
                          onClick={() => printStatement({ id: c.customerId })}
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.57-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5z" />
                          </svg>
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            openReceivePayment({
                              id: c.customerId,
                              name: c.name,
                              phone: c.phone ?? undefined,
                              outstandingBalance: c.total,
                            })
                          }
                        >
                          {t("customers.collect")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Input
            placeholder={t("customers.searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            leftIcon={
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            }
            wrapperClassName="w-full sm:w-80"
          />
          {hasSearch && (
            <button
              type="button"
              onClick={() => { setSearchInput(""); setSearch(""); }}
              className="text-xs font-medium text-neu-accent-ink transition-colors hover:text-neu-accent-ink-strong"
            >
              {t("common.clearFilters")}
            </button>
          )}
          <span className="ms-auto hidden text-xs tabular-nums text-neu-faint sm:block">
            {formatNumber(total)} {t("customers.inDatabase")}
          </span>
        </CardContent>
      </Card>

      {/* Customers Table */}
      <Card>
        {/* Mobile / tablet: stacked customer cards */}
        <div className="divide-y divide-neu-hairline md:hidden">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-20 rounded-xl" style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          ) : loadError ? (
            errorStateNode
          ) : customers.length === 0 ? (
            emptyStateNode
          ) : (
            customers.map((c) => {
              const due = c.outstandingBalance ?? 0;
              return (
                <div
                  key={c.id}
                  className="cursor-pointer px-4 py-3.5 transition-colors hover:bg-neu-sunken/60"
                  onClick={() => viewDetail(c)}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neu-accent-wash text-xs font-bold text-neu-accent-ink-strong">
                      {getInitials(c.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-neu-primary">{c.name}</p>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-neu-primary">
                          {formatCurrency(c.totalSpent)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-neu-faint">{c.phone || c.email || "—"}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] tabular-nums text-neu-faint">
                          {c._count?.orders ?? c.orderCount} {t("customers.orders")}
                        </span>
                        <LoyaltyChip points={c.loyaltyPoints} />
                        {due > 0 && (
                          <Badge variant="warning" size="sm" className="tabular-nums">
                            {formatCurrency(due)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop: full ledger table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neu-hairline bg-neu-sunken">
                <SortableTh label={t("customers.name")} active={sortBy === "name"} order={sortOrder} onClick={() => toggleSort("name")} />
                <th className="hidden whitespace-nowrap px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-neu-faint lg:table-cell">
                  {t("customers.contact")}
                </th>
                <SortableTh label={t("customers.orders")} align="end" active={sortBy === "orderCount"} order={sortOrder} onClick={() => toggleSort("orderCount")} />
                <SortableTh label={t("customers.totalSpent")} align="end" active={sortBy === "totalSpent"} order={sortOrder} onClick={() => toggleSort("totalSpent")} />
                <SortableTh label={t("customers.balanceDue")} align="end" active={sortBy === "outstandingBalance"} order={sortOrder} onClick={() => toggleSort("outstandingBalance")} />
                <SortableTh label={t("customers.loyalty")} align="end" active={sortBy === "loyaltyPoints"} order={sortOrder} onClick={() => toggleSort("loyaltyPoints")} />
                <th className="whitespace-nowrap px-4 py-3 text-end text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("customers.actions")}</th>
              </tr>
            </thead>
            <tbody ref={tbodyRef} className="divide-y divide-neu-hairline">
              {loading ? (
                <TableSkeleton rows={6} />
              ) : loadError ? (
                <tr>
                  <td colSpan={7} className="p-0">{errorStateNode}</td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-0">{emptyStateNode}</td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id} data-nav-row data-nav-label={c.name} className="cursor-pointer transition-colors hover:bg-neu-sunken/50" onClick={() => viewDetail(c)}>
                    <td className="max-w-[240px] px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neu-accent-wash text-xs font-bold text-neu-accent-ink-strong">
                          {getInitials(c.name)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-neu-primary">{c.name}</p>
                          <p className="truncate text-xs text-neu-faint">
                            {t("customers.since")} {formatDate(c.createdAt, "short")}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="hidden max-w-[200px] px-4 py-3 lg:table-cell">
                      <p className="truncate text-sm text-neu-muted">{c.email || "—"}</p>
                      <p className="truncate text-xs tabular-nums text-neu-faint">{c.phone || "—"}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end text-sm tabular-nums text-neu-primary">
                      {c._count?.orders ?? c.orderCount}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end text-sm font-semibold tabular-nums text-neu-primary">
                      {formatCurrency(c.totalSpent)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">
                      {(c.outstandingBalance ?? 0) > 0 ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <Badge variant="warning" size="sm" className="tabular-nums">
                            {formatCurrency(c.outstandingBalance)}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-neu-ink-green hover:bg-neu-wash-green"
                            title={t("customers.receivePayment")}
                            aria-label={t("customers.receivePayment")}
                            onClick={(e) => { e.stopPropagation(); openReceivePayment(c); }}
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-neu-faint">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">
                      <LoyaltyChip points={c.loyaltyPoints} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); openEdit(c); }} title={t("common.edit")} aria-label={t("common.edit")}>
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </Button>
                        <Button variant="ghost" size="icon-sm" className="text-neu-ink-red hover:bg-neu-wash-red" onClick={(e) => { e.stopPropagation(); setDeleteConfirm(c); }} title={t("common.delete")} aria-label={t("common.delete")}>
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-col items-center justify-between gap-3 border-t border-neu-hairline px-4 py-3 sm:flex-row">
            <p className="text-center text-xs tabular-nums text-neu-faint sm:text-start sm:text-sm">
              {t("common.page")} {page} {t("common.of")} {totalPages}
              {" · "}
              {formatNumber(total)} {t("customers.totalCount")}
            </p>
            <div className="flex gap-1">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("common.previous")}</Button>
              <Button variant="secondary" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>{t("common.next")}</Button>
            </div>
          </div>
        )}
      </Card>

      {/* ═══ CREATE/EDIT MODAL ═══ */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) { setCreateOpen(false); setEditCustomer(null); resetForm(); } }}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{editCustomer ? t("customers.editCustomer") : t("customers.addCustomer")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {formErrors["_form"] && (
              <div className="rounded-lg border border-neu-ink-red/20 bg-neu-wash-red p-3 text-sm text-neu-ink-red">{formErrors["_form"].join(", ")}</div>
            )}
            <Input label={`${t("customers.name")} *`} placeholder={t("customers.fullNamePlaceholder")} value={formName} onChange={(e) => setFormName(e.target.value)} error={formErrors["name"]?.join(", ")} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input label={t("customers.email")} type="email" placeholder="email@example.com" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} error={formErrors["email"]?.join(", ")} />
              <Input label={t("customers.phone")} placeholder="+1 (555) 000-0000" value={formPhone} onChange={(e) => setFormPhone(e.target.value)} error={formErrors["phone"]?.join(", ")} />
            </div>
            <Input label={t("customers.address")} placeholder={t("customers.addressPlaceholder")} value={formAddress} onChange={(e) => setFormAddress(e.target.value)} />
            <Input label={t("customers.notes")} placeholder={t("customers.notesPlaceholder")} value={formNotes} onChange={(e) => setFormNotes(e.target.value)} />
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => { setCreateOpen(false); setEditCustomer(null); resetForm(); }}>{t("common.cancel")}</Button>
            <Button loading={formLoading} onClick={handleSave} disabled={!formName.trim()}>
              {editCustomer ? t("common.saveChanges") : t("customers.addCustomer")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ CUSTOMER DETAIL MODAL ═══ */}
      <Dialog open={Boolean(detailCustomer)} onOpenChange={(o) => !o && setDetailCustomer(null)}>
        <DialogContent size="lg" height="tall">
          <DialogHeader>
            {detailCustomer && !detailLoading ? (
              <div className="flex items-center gap-4 w-full">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-neu-accent-wash text-lg font-bold text-neu-accent-ink-strong">
                  {getInitials(detailCustomer.name)}
                </div>
                <div>
                  <DialogTitle>{detailCustomer.name}</DialogTitle>
                  <p className="text-sm text-neu-faint">
                    {detailCustomer.email || t("customers.noEmail")} · {detailCustomer.phone || t("customers.noPhone")}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-4 w-full">
                <div className="skeleton h-14 w-14 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-5 w-40" />
                  <div className="skeleton h-3.5 w-56" />
                </div>
              </div>
            )}
          </DialogHeader>
          <DialogBody className="space-y-4">
            {detailLoading ? (
              <div className="space-y-4">
                <div className="skeleton h-24 w-full rounded-lg" />
                <div className="grid grid-cols-3 gap-3">
                  <div className="skeleton h-16 w-full rounded-lg" />
                  <div className="skeleton h-16 w-full rounded-lg" />
                  <div className="skeleton h-16 w-full rounded-lg" />
                </div>
                <div className="skeleton h-48 w-full rounded-lg" />
              </div>
            ) : detailCustomer ? (
              <>
                {/* Outstanding dues banner + open credit orders */}
                {(detailCustomer.outstandingBalance ?? 0) > 0 && (
                  <div className="rounded-lg border border-neu-ink-amber/35 bg-neu-wash-amber p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-semibold text-neu-ink-amber">{t("customers.balanceDue")}</p>
                        <p className="text-xl font-bold tabular-nums text-neu-ink-amber">
                          {formatCurrency(detailCustomer.outstandingBalance ?? 0)}
                        </p>
                        {detailCustomer.creditOrderCount ? (
                          <p className="text-[11px] text-neu-ink-amber">{t("customers.creditOrdersCount")}: {detailCustomer.creditOrderCount}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button variant="secondary" size="sm" onClick={() => printStatement(detailCustomer)}>
                          {t("customers.printStatement")}
                        </Button>
                        <Button size="sm" onClick={() => { setDetailCustomer(null); openReceivePayment(detailCustomer); }}>
                          {t("customers.receivePayment")}
                        </Button>
                      </div>
                    </div>
                    {detailCustomer.openCreditOrders && detailCustomer.openCreditOrders.length > 0 && (
                      <div className="mt-2 divide-y divide-neu-ink-amber/35">
                        {detailCustomer.openCreditOrders.map((o) => (
                          <div key={o.id} className="flex items-center justify-between py-1.5 text-xs">
                            <span className="font-medium text-neu-primary">{o.orderNumber}</span>
                            <span className="tabular-nums text-neu-faint">
                              {formatCurrency(o.paidAmount)} / {formatCurrency(o.total)} · <span className="font-semibold text-neu-ink-amber">{formatCurrency(o.dueAmount)}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Stats */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {[
                    { label: t("customers.totalSpent"), value: formatCurrency(detailCustomer.calculatedTotalSpent), accent: "text-neu-primary" },
                    { label: t("customers.loyaltyPoints"), value: formatNumber(detailCustomer.loyaltyPoints), accent: "text-neu-ink-amber" },
                    { label: t("customers.orders"), value: formatNumber(detailCustomer.recentOrderCount), accent: "text-neu-primary" },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg bg-neu-sunken p-3 text-center">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-neu-faint">{s.label}</p>
                      <p className={cn("mt-0.5 text-lg font-bold tabular-nums", s.accent)}>{s.value}</p>
                    </div>
                  ))}
                </div>

                {/* Address & Notes */}
                {(detailCustomer.address || detailCustomer.notes) && (
                  <div className="space-y-1.5 rounded-lg border border-neu-hairline bg-neu-sunken/60 p-3">
                    {detailCustomer.address && (
                      <p className="flex items-start gap-2 text-sm text-neu-muted">
                        <svg className="mt-0.5 h-4 w-4 shrink-0 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                        </svg>
                        <span>{detailCustomer.address}</span>
                      </p>
                    )}
                    {detailCustomer.notes && (
                      <p className="flex items-start gap-2 text-xs text-neu-faint">
                        <svg className="mt-0.5 h-4 w-4 shrink-0 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zM19 13.5V19.5a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 19.5V8.25A2.25 2.25 0 015.25 6h6" />
                        </svg>
                        <span>{detailCustomer.notes}</span>
                      </p>
                    )}
                  </div>
                )}

                {/* Purchase History */}
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-neu-primary">{t("customers.purchaseHistory")}</p>
                    {detailCustomer.orders.length > 0 && (
                      <span className="text-xs tabular-nums text-neu-faint">
                        {t("orders.itemsCount", { n: detailCustomer.orders.length })}
                      </span>
                    )}
                  </div>
                  {detailCustomer.orders.length === 0 ? (
                    <p className="py-4 text-center text-sm text-neu-faint">{t("customers.noOrdersYet")}</p>
                  ) : (
                    <div className="max-h-[300px] divide-y divide-neu-hairline overflow-y-auto rounded-lg border border-neu-hairline">
                      {detailCustomer.orders.map((order) => (
                        <div key={order.id} className="px-3 py-2.5 transition-colors hover:bg-neu-sunken/60">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-mono text-[13px] font-semibold text-neu-primary">{order.orderNumber}</p>
                              <p className="truncate text-xs text-neu-faint">
                                {formatDate(order.createdAt, "medium")}
                                {order.items.length > 0 && (
                                  <>
                                    {" · "}
                                    {order.items.slice(0, 2).map((i) => i.productName).join(", ")}
                                    {order.items.length > 2 ? ` +${order.items.length - 2}` : ""}
                                  </>
                                )}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Badge variant={order.status === "completed" ? "success" : order.status === "refunded" ? "danger" : "default"} size="sm">
                                {t(`orders.${order.status}`)}
                              </Badge>
                              <span className="text-sm font-semibold tabular-nums text-neu-primary">{formatCurrency(order.total)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setDetailCustomer(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ RECEIVE PAYMENT MODAL ═══ */}
      <Dialog open={Boolean(payCustomer)} onOpenChange={(o) => !o && setPayCustomer(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("customers.receivePayment")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {payCustomer && (
              <>
                <div className="flex items-center justify-between rounded-lg bg-neu-sunken p-3">
                  <div>
                    <p className="text-sm font-semibold text-neu-primary">{payCustomer.name}</p>
                    <p className="text-xs text-neu-faint">{payCustomer.phone || payCustomer.email || "—"}</p>
                  </div>
                  <div className="text-end">
                    <p className="text-xs text-neu-faint">{t("customers.balanceDue")}</p>
                    <p className="text-lg font-bold tabular-nums text-neu-ink-amber">{formatCurrency(payCustomer.outstandingBalance ?? 0)}</p>
                  </div>
                </div>
                <Input
                  label={`${t("customers.paymentAmount")}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  {["cash", "credit_card", "digital_wallet", "bank_transfer"].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setPayMethod(m)}
                      className={cn(
                        "flex-1 rounded-lg border-2 px-2 py-1.5 text-xs font-medium transition-colors",
                        payMethod === m
                          ? "border-neu-accent-line bg-neu-accent-wash text-neu-accent-ink-strong"
                          : "border-neu-hairline text-neu-faint hover:bg-neu-sunken"
                      )}
                    >
                      {t(`pos.paymentMethod.${m}`)}
                    </button>
                  ))}
                </div>
                <Input
                  label={t("customers.paymentNotes")}
                  placeholder={t("customers.paymentNotesPlaceholder")}
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                />
                <p className="text-xs text-neu-faint">{t("customers.paymentFifoHint")}</p>
              </>
            )}
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setPayCustomer(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              loading={payLoading}
              disabled={displayMajorToBaseCents(parseFloat(payAmount) || 0, fx) <= 0}
              onClick={submitPayment}
            >
              {t("customers.recordPayment")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ DELETE CONFIRMATION ═══ */}
      <Dialog open={Boolean(deleteConfirm)} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>{t("customers.removeCustomer")}</DialogTitle></DialogHeader>
          <DialogBody>
            <p className="text-sm text-neu-muted">
              {t("customers.removeConfirmPrefix")} <span className="font-semibold">{deleteConfirm?.name}</span>? {t("customers.removeConfirmNote")}
            </p>
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={deleting} onClick={handleDelete}>{t("customers.remove")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ IMPORT RESULT DIALOG (stat cards + per-row errors) ═══ */}
      <ImportResultDialog
        open={resultOpen}
        onClose={() => setResultOpen(false)}
        result={importResult}
        entityLabel="customers"
      />
    </div>
  );
}
