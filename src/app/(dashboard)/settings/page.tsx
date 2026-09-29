"use client";

import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { NotificationDeliveryLog } from "@/components/settings/notification-delivery-log";
import { parseApiError } from "@/lib/api-error";
import { toast } from "@/stores/toast-store";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn, setCurrencyDefaults } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

/* ═══════════════════════════════════════════════════════════════
   SETTINGS PAGE
   Store configuration, tax & currency, and receipt preferences.
   Persists through the /api/settings singleton route.
   ═══════════════════════════════════════════════════════════════ */

interface Settings {
  storeName: string;
  storeAddress: string;
  storePhone: string;
  storeEmail: string;
  taxRate: number;
  taxInclusive: boolean;
  currency: string;
  receiptHeader: string;
  receiptFooter: string;
  lowStockThreshold: number;
  allowPublicRegistration: boolean;
  // Notification config
  webhookUrl: string;
  webhookSecret: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  smtpFromEmail: string;
  smtpFromName: string;
  smtpUseTls: boolean;
  lowStockNotifyWebhook: boolean;
  lowStockNotifyEmail: boolean;
  lowStockNotifyAdmins: boolean;
  // Scheduled low-stock scanning
  lowStockSchedulerEnabled: boolean;
  lowStockCooldownHours: number;
  lowStockMinQuantity: number | null;
  /** Opt-in early warnings — never counted as low stock. */
  lowStockRunningLowAlerts: boolean;
}

const EMPTY: Settings = {
  storeName: "",
  storeAddress: "",
  storePhone: "",
  storeEmail: "",
  taxRate: 0,
  taxInclusive: false,
  currency: "USD",
  receiptHeader: "",
  receiptFooter: "",
  lowStockThreshold: 5,
  allowPublicRegistration: false,
  webhookUrl: "",
  webhookSecret: "",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPassword: "",
  smtpFromEmail: "",
  smtpFromName: "",
  smtpUseTls: true,
  lowStockNotifyWebhook: false,
  lowStockNotifyEmail: false,
  lowStockNotifyAdmins: true,
  lowStockSchedulerEnabled: true,
  lowStockCooldownHours: 6,
  lowStockMinQuantity: null,
  lowStockRunningLowAlerts: false,
};

export default function SettingsPage() {
  const { t } = useI18n();
  const [form, setForm] = React.useState<Settings>(EMPTY);
  const [loading, setLoading] = React.useState(true);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [loadError, setLoadError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [refundPresets, setRefundPresets] = React.useState<string[]>([]);
  const [newPreset, setNewPreset] = React.useState("");

  // Load current settings
  React.useEffect(() => {
    setLoadError(false);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.settings) {
          setForm({
            storeName: d.settings.storeName ?? "",
            storeAddress: d.settings.storeAddress ?? "",
            storePhone: d.settings.storePhone ?? "",
            storeEmail: d.settings.storeEmail ?? "",
            taxRate: d.settings.taxRate ?? 0,
            taxInclusive: d.settings.taxInclusive ?? false,
            currency: d.settings.currency ?? "USD",
            receiptHeader: d.settings.receiptHeader ?? "",
            receiptFooter: d.settings.receiptFooter ?? "",
            lowStockThreshold: d.settings.lowStockThreshold ?? 5,
            allowPublicRegistration: d.settings.allowPublicRegistration ?? false,
            webhookUrl: d.settings.webhookUrl ?? "",
            webhookSecret: d.settings.webhookSecret ?? "",
            smtpHost: d.settings.smtpHost ?? "",
            smtpPort: d.settings.smtpPort ?? 587,
            smtpUser: d.settings.smtpUser ?? "",
            smtpPassword: d.settings.smtpPassword ?? "",
            smtpFromEmail: d.settings.smtpFromEmail ?? "",
            smtpFromName: d.settings.smtpFromName ?? "",
            smtpUseTls: d.settings.smtpUseTls ?? true,
            lowStockNotifyWebhook: d.settings.lowStockNotifyWebhook ?? false,
            lowStockNotifyEmail: d.settings.lowStockNotifyEmail ?? false,
            lowStockNotifyAdmins: d.settings.lowStockNotifyAdmins ?? true,
            lowStockSchedulerEnabled: d.settings.lowStockSchedulerEnabled ?? true,
            lowStockCooldownHours: d.settings.lowStockCooldownHours ?? 6,
            lowStockMinQuantity:
              d.settings.lowStockMinQuantity === null || d.settings.lowStockMinQuantity === undefined
                ? null
                : Number(d.settings.lowStockMinQuantity),
            lowStockRunningLowAlerts: d.settings.lowStockRunningLowAlerts ?? false,
          });
          if (d.settings.refundReasonPresets) {
            try {
              const arr = JSON.parse(d.settings.refundReasonPresets);
              if (Array.isArray(arr)) {
                setRefundPresets(
                  arr.filter((s) => typeof s === "string" && s.trim() && s.trim() !== "custom").map((s) => s.trim())
                );
              }
            } catch { /* ignore malformed stored value */ }
          }
        }
      })
      .catch(() => {
        setLoadError(true);
        toast.error(t("settings.loadFailed"));
      })
      .finally(() => setLoading(false));
    // Reload on an explicit retry; NOT on locale change, which would clobber
    // unsaved edits with the stored values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    // Editing a field retracts its server-side complaint — the user is acting
    // on it, so the red ring should not linger while they retype.
    setFieldErrors((prev) => {
      const field = key as string;
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function addPreset() {
    const v = newPreset.trim();
    if (!v || v === "custom" || refundPresets.includes(v)) return;
    setRefundPresets((prev) => [...prev, v]);
    setNewPreset("");
    setDirty(true);
  }

  function removePreset(idx: number) {
    setRefundPresets((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }

  async function handleSave() {
    if (!form.storeName.trim()) {
      toast.error(t("settings.nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          // Empty list = use the built-in localized presets (store "", not "[]")
          refundReasonPresets: refundPresets.length > 0 ? JSON.stringify(refundPresets) : "",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Zod returns field-keyed errors — underline the offending inputs.
        // A plain-string error has no field to attach to, so it toasts.
        const { fields, message } = parseApiError(data, t("settings.saveFailed"));
        setFieldErrors(fields);
        if (Object.keys(fields).length === 0) toast.error(message);
        return;
      }
      setFieldErrors({});
      setDirty(false);
      // Apply a changed display currency immediately — formatCurrency
      // defaults are store-wide, so the whole UI (and receipts) switches
      // without a reload.
      const savedCurrency = (data?.settings as { currency?: string } | undefined)?.currency;
      if (savedCurrency) {
        setCurrencyDefaults(savedCurrency);
        useSettingsStore.getState().setCurrency(savedCurrency);
      }
      toast.success(t("settings.saved"), t("settings.savedDesc"));
    } catch {
      toast.error(t("settings.networkError"), t("settings.networkErrorDesc"));
    } finally {
      setSaving(false);
    }
  }

  // Manually fire one scan + delivery pass (honors the per-item cooldown,
  // so repeated runs never spam the same product+warehouse).
  async function runLowStockNow() {
    setRunning(true);
    try {
      const res = await fetch("/api/notifications/low-stock/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t("settings.saveFailed"));
        return;
      }
      const parts = [];
      if (typeof data.sent === "number") parts.push(`${data.sent} ${t("settings.notifSent")}`);
      if (typeof data.throttled === "number" && data.throttled > 0) parts.push(`${data.throttled} ${t("settings.notifThrottled")}`);
      if (typeof data.scanned === "number" && data.scanned === 0) parts.push(t("settings.notifNoneLow"));
      toast.success(parts.length > 0 ? parts.join(" · ") : t("settings.notifDone"));
    } catch {
      toast.error(t("settings.networkError"));
    } finally {
      setRunning(false);
    }
  }

  async function exportProducts() {
    setExporting(true);
    try {
      // Shared catalog endpoint — exports the FULL active catalog (the
      // products list endpoint paginates and used to cap exports at 100).
      const res = await fetch("/api/products/lookup?limit=500&withStock=true");
      const data = await res.json();
      const items = data.products ?? [];

      const rows = [
        [t("products.name"), "SKU", t("products.barcode"), t("products.category"), t("products.price"), t("products.cost"), t("products.status"), t("products.stock")],
        ...items.map((p: { name: string; sku: string; barcode?: string; categoryName?: string | null; unitPrice: number; costPrice: number; totalStock: number }) => [
          `"${p.name.replace(/"/g, '""')}"`,
          p.sku,
          p.barcode ?? "",
          p.categoryName ?? "",
          (p.unitPrice / 100).toFixed(2),
          (p.costPrice / 100).toFixed(2),
          "active",
          String(p.totalStock ?? 0),
        ]),
      ];
      const csv = rows.map((r) => r.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `products-export-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("settings.exportStarted"), `${items.length} ${t("settings.exportedProducts")}`);
    } catch {
      toast.error(t("settings.exportFailed"), t("settings.exportFailedDesc"));
    } finally {
      setExporting(false);
    }
  }

  // ─── Background jobs ─────────────────────────────────────────
  interface JobRun {
    job: string;
    source: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    ok: boolean;
    summary: Record<string, number | string>;
    error?: string;
  }
  const [jobs, setJobs] = React.useState<Record<string, JobRun | null>>({});
  const [jobsLoading, setJobsLoading] = React.useState(true);
  const [runningMaintenance, setRunningMaintenance] = React.useState(false);

  const loadJobs = React.useCallback(async () => {
    try {
      const res = await fetch("/api/system/jobs");
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<string, JobRun | null> = {};
      for (const j of (data.jobs ?? []) as Array<{ job: string; lastRun: JobRun | null }>) {
        map[j.job] = j.lastRun;
      }
      setJobs(map);
    } catch {
      /* status card is best-effort */
    } finally {
      setJobsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  async function runMaintenanceNow() {
    setRunningMaintenance(true);
    try {
      const res = await fetch("/api/maintenance/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t("settings.saveFailed"));
        return;
      }
      toast.success(
        t("settings.maintenanceDone"),
        t("settings.maintenanceDoneDesc")
          .replace("{pruned}", String(data.prunedLoginAttempts ?? 0))
          .replace("{deleted}", String(data.deletedOrphans?.length ?? 0))
          .replace("{scanned}", String(data.scannedFiles ?? 0))
      );
      void loadJobs();
    } catch {
      toast.error(t("settings.networkError"));
    } finally {
      setRunningMaintenance(false);
    }
  }

  function formatJobRun(run: JobRun | null | undefined): string {
    if (!run) return t("settings.jobNeverRun");
    const ago = Math.max(0, Date.now() - new Date(run.finishedAt).getTime());
    const mins = Math.floor(ago / 60000);
    const when =
      mins < 1
        ? t("settings.jobJustNow")
        : mins < 60
          ? t("settings.jobMinsAgo").replace("{n}", String(mins))
          : t("settings.jobHoursAgo").replace("{n}", String(Math.floor(mins / 60)));
    return `${when} · ${run.ok ? t("settings.jobOk") : t("settings.jobFailed")}`;
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-8 w-48 rounded" />
        <div className="grid gap-6 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className={i < 2 ? "lg:col-span-1" : ""}>
              <CardContent className="p-6 space-y-3">
                <div className="skeleton h-4 w-32 rounded" />
                <div className="skeleton h-9 w-full rounded" />
                <div className="skeleton h-9 w-full rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("settings.title")}
          description={t("settings.pageDescription")}
          breadcrumbs={[
            { label: t("dashboard.title"), href: "/dashboard" },
            { label: t("settings.title") },
          ]}
        />
        <EmptyState
          error
          title={t("settings.loadFailed")}
          description={t("common.loadFailedDesc")}
          icon={
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
          }
          action={
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t("common.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("settings.title")}
        description={t("settings.pageDescription")}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("settings.title") },
        ]}
        actions={
          <Button onClick={handleSave} loading={saving} disabled={!dirty}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {t("settings.save")}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Store Information */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("settings.storeInfo")}</CardTitle>
            <CardDescription>
              {t("settings.storeInfoDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              label={`${t("settings.storeName")} *`}
              placeholder={t("settings.storeNamePlaceholder")}
              value={form.storeName}
              error={fieldErrors["storeName"]}
              onChange={(e) => update("storeName", e.target.value)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t("settings.storePhone")}
                placeholder="+92 300 0000000"
                value={form.storePhone}
                error={fieldErrors["storePhone"]}
                onChange={(e) => update("storePhone", e.target.value)}
              />
              <Input
                label={t("settings.storeEmail")}
                placeholder="store@example.com"
                type="email"
                value={form.storeEmail}
                error={fieldErrors["storeEmail"]}
                onChange={(e) => update("storeEmail", e.target.value)}
              />
            </div>
            <Input
              label={t("settings.storeAddress")}
              placeholder={t("settings.storeAddressPlaceholder")}
              value={form.storeAddress}
              onChange={(e) => update("storeAddress", e.target.value)}
            />
          </CardContent>
        </Card>

        {/* Tax & Currency */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.taxCurrency")}</CardTitle>
            <CardDescription>
              {t("settings.taxCurrencyDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              label={t("settings.taxRateLabel")}
              type="number"
              placeholder="0"
              value={String(form.taxRate)}
              min="0"
              max="100"
              step="0.01"
              error={fieldErrors["taxRate"]}
              onChange={(e) => update("taxRate", parseFloat(e.target.value) || 0)}
            />
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="taxInclusive"
                checked={form.taxInclusive}
                onChange={(e) => update("taxInclusive", e.target.checked)}
                className="h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
              />
              <label htmlFor="taxInclusive" className="text-sm text-neu-primary">
                {t("settings.taxInclusive")}
              </label>
            </div>
            <div>
              <label className="text-sm font-medium text-neu-primary">{t("settings.currency")}</label>
              <select
                className="mt-1.5 h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary neu-focus"
                value={form.currency}
                onChange={(e) => update("currency", e.target.value)}
              >
                <option value="PKR">{t("settings.cur.pkr")}</option>
                <option value="USD">{t("settings.cur.usd")}</option>
                <option value="EUR">{t("settings.cur.eur")}</option>
                <option value="GBP">{t("settings.cur.gbp")}</option>
                <option value="CAD">{t("settings.cur.cad")}</option>
                <option value="AED">{t("settings.cur.aed")}</option>
                <option value="SAR">{t("settings.cur.sar")}</option>
              </select>
            </div>
          </CardContent>
        </Card>

        {/* Receipt Settings */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("settings.receiptSection")}</CardTitle>
            <CardDescription>
              {t("settings.receiptSectionDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              label={t("settings.receiptHeader")}
              placeholder={t("settings.receiptHeaderPlaceholder")}
              value={form.receiptHeader}
              onChange={(e) => update("receiptHeader", e.target.value)}
            />
            <Input
              label={t("settings.receiptFooter")}
              placeholder={t("settings.receiptFooterPlaceholder")}
              value={form.receiptFooter}
              onChange={(e) => update("receiptFooter", e.target.value)}
            />
            <Input
              label={t("settings.lowStockThreshold")}
              type="number"
              placeholder="5"
              value={String(form.lowStockThreshold)}
              min="0"
              error={fieldErrors["lowStockThreshold"]}
              onChange={(e) => update("lowStockThreshold", parseInt(e.target.value) || 0)}
              hint={t("settings.lowStockHint")}
            />
          </CardContent>
        </Card>

        {/* Security & Registration */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("settings.securityTitle")}</CardTitle>
            <CardDescription>
              {t("settings.securityDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-start justify-between gap-6 rounded-lg border border-neu-hairline bg-neu-sunken p-4">
              <div>
                <p className="text-sm font-medium text-neu-primary">{t("settings.allowPublicReg")}</p>
                <p className="mt-1 text-xs text-neu-faint max-w-md">
                  {t("settings.allowPublicRegHint")}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.allowPublicRegistration}
                onClick={() => update("allowPublicRegistration", !form.allowPublicRegistration)}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                  form.allowPublicRegistration ? "bg-neu-solid-green" : "bg-neu-sunken"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 transform rounded-full bg-neu-bg shadow transition-transform",
                    form.allowPublicRegistration ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1"
                  )}
                />
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Refund reasons presets */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("settings.refundReasonsTitle")}</CardTitle>
            <CardDescription>
              {t("settings.refundReasonsDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-neu-faint">{t("settings.refundReasonsHint")}</p>
            {refundPresets.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {refundPresets.map((preset, i) => (
                  <span
                    key={`${preset}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-neu-hairline bg-neu-sunken py-1 ps-3 pe-1.5 text-sm text-neu-primary"
                  >
                    {preset}
                    <button
                      type="button"
                      onClick={() => removePreset(i)}
                      aria-label={t("common.remove")}
                      className="flex h-5 w-5 items-center justify-center rounded-full text-neu-faint transition-colors hover:bg-neu-wash-red hover:text-neu-ink-red"
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <EmptyState bare className="py-6" title={t("settings.refundReasonsEmpty")} />
            )}
            <div className="flex gap-2">
              <Input
                placeholder={t("settings.refundReasonAddPlaceholder")}
                value={newPreset}
                onChange={(e) => setNewPreset(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPreset();
                  }
                }}
                wrapperClassName="max-w-sm"
              />
              <Button variant="secondary" onClick={addPreset} disabled={!newPreset.trim()}>
                {t("settings.refundReasonAdd")}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Notification Settings */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("settings.notificationsTitle")}</CardTitle>
            <CardDescription>
              {t("settings.notificationsDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* In-app admin notifications */}
            <div className="flex items-start justify-between gap-6 rounded-lg border border-neu-hairline bg-neu-sunken p-4">
              <div>
                <p className="text-sm font-medium text-neu-primary">{t("settings.notifyAdmins")}</p>
                <p className="mt-1 text-xs text-neu-faint max-w-md">{t("settings.notifyAdminsHint")}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.lowStockNotifyAdmins}
                onClick={() => update("lowStockNotifyAdmins", !form.lowStockNotifyAdmins)}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                  form.lowStockNotifyAdmins ? "bg-neu-solid-green" : "bg-neu-sunken"
                )}
              >
                <span className={cn("inline-block h-4 w-4 transform rounded-full bg-neu-bg shadow transition-transform", form.lowStockNotifyAdmins ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1")} />
              </button>
            </div>

            {/* Opt-in early restock warnings. Off by default and deliberately
                excluded from every low-stock count so switching it on cannot
                change the Needs Restock number. */}
            <div className="flex items-start justify-between gap-6 rounded-lg border border-neu-hairline bg-neu-sunken p-4">
              <div>
                <p className="text-sm font-medium text-neu-primary">{t("settings.runningLowAlerts")}</p>
                <p className="mt-1 text-xs text-neu-faint max-w-md">{t("settings.runningLowAlertsHint")}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.lowStockRunningLowAlerts}
                onClick={() => update("lowStockRunningLowAlerts", !form.lowStockRunningLowAlerts)}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                  form.lowStockRunningLowAlerts ? "bg-neu-solid-green" : "bg-neu-sunken"
                )}
              >
                <span className={cn("inline-block h-4 w-4 transform rounded-full bg-neu-bg shadow transition-transform", form.lowStockRunningLowAlerts ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1")} />
              </button>
            </div>

            {/* Webhook */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-neu-primary">{t("settings.webhookTitle")}</h4>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.lowStockNotifyWebhook}
                  onClick={() => update("lowStockNotifyWebhook", !form.lowStockNotifyWebhook)}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                    form.lowStockNotifyWebhook ? "bg-neu-solid-green" : "bg-neu-sunken"
                  )}
                >
                  <span className={cn("inline-block h-4 w-4 transform rounded-full bg-neu-bg shadow transition-transform", form.lowStockNotifyWebhook ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1")} />
                </button>
              </div>
              {form.lowStockNotifyWebhook && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label={t("settings.webhookUrl")}
                    placeholder="https://hooks.example.com/stock-alerts"
                    value={form.webhookUrl}
                    error={fieldErrors["webhookUrl"]}
                    onChange={(e) => update("webhookUrl", e.target.value)}
                  />
                  <Input
                    label={t("settings.webhookSecret")}
                    type="password"
                    placeholder="Optional HMAC-SHA256 secret"
                    value={form.webhookSecret}
                    onChange={(e) => update("webhookSecret", e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Scheduled scanning */}
            <div className="space-y-3 border-t border-neu-hairline pt-5">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-neu-primary">{t("settings.schedulerTitle")}</h4>
                  <p className="mt-0.5 text-xs text-neu-faint">{t("settings.schedulerHint")}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.lowStockSchedulerEnabled}
                  onClick={() => update("lowStockSchedulerEnabled", !form.lowStockSchedulerEnabled)}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                    form.lowStockSchedulerEnabled ? "bg-neu-solid-green" : "bg-neu-sunken"
                  )}
                >
                  <span className={cn("inline-block h-4 w-4 transform rounded-full bg-neu-bg shadow transition-transform", form.lowStockSchedulerEnabled ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1")} />
                </button>
              </div>

              {form.lowStockSchedulerEnabled && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label={t("settings.cooldownLabel")}
                    type="number"
                    min="0.5"
                    max="720"
                    step="0.5"
                    placeholder="6"
                    value={String(form.lowStockCooldownHours)}
                    error={fieldErrors["lowStockCooldownHours"]}
                    onChange={(e) => update("lowStockCooldownHours", parseFloat(e.target.value) || 6)}
                    hint={t("settings.cooldownHint")}
                  />
                  <Input
                    label={t("settings.minQtyLabel")}
                    type="number"
                    min="0"
                    placeholder="0"
                    value={
                      form.lowStockMinQuantity === null
                        ? ""
                        : String(form.lowStockMinQuantity)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      update("lowStockMinQuantity", v === "" ? null : Number(v));
                    }}
                    hint={t("settings.minQtyHint")}
                  />
                </div>
              )}

              <div className="flex items-center justify-between gap-4 rounded-lg border border-neu-hairline bg-neu-sunken p-3">
                <p className="text-xs text-neu-faint max-w-sm">{t("settings.runNowHint")}</p>
                <Button variant="secondary" size="sm" onClick={runLowStockNow} loading={running}>
                  {t("settings.runNow")}
                </Button>
              </div>
            </div>

            {/* Email SMTP */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-neu-primary">{t("settings.emailTitle")}</h4>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.lowStockNotifyEmail}
                  onClick={() => update("lowStockNotifyEmail", !form.lowStockNotifyEmail)}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                    form.lowStockNotifyEmail ? "bg-neu-solid-green" : "bg-neu-sunken"
                  )}
                >
                  <span className={cn("inline-block h-4 w-4 transform rounded-full bg-neu-bg shadow transition-transform", form.lowStockNotifyEmail ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1")} />
                </button>
              </div>
              {form.lowStockNotifyEmail && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label={t("settings.smtpHost")}
                    placeholder="smtp.gmail.com"
                    value={form.smtpHost}
                    onChange={(e) => update("smtpHost", e.target.value)}
                  />
                  <Input
                    label={t("settings.smtpPort")}
                    type="number"
                    placeholder="587"
                    value={String(form.smtpPort)}
                    error={fieldErrors["smtpPort"]}
                    onChange={(e) => update("smtpPort", parseInt(e.target.value) || 587)}
                  />
                  <Input
                    label={t("settings.smtpUser")}
                    placeholder="user@example.com"
                    value={form.smtpUser}
                    onChange={(e) => update("smtpUser", e.target.value)}
                  />
                  <Input
                    label={t("settings.smtpPassword")}
                    type="password"
                    placeholder="••••••••"
                    value={form.smtpPassword}
                    onChange={(e) => update("smtpPassword", e.target.value)}
                  />
                  <Input
                    label={t("settings.smtpFromEmail")}
                    placeholder="alerts@yourstore.com"
                    value={form.smtpFromEmail}
                    error={fieldErrors["smtpFromEmail"]}
                    onChange={(e) => update("smtpFromEmail", e.target.value)}
                  />
                  <Input
                    label={t("settings.smtpFromName")}
                    placeholder="Store Name"
                    value={form.smtpFromName}
                    onChange={(e) => update("smtpFromName", e.target.value)}
                  />
                  <div className="sm:col-span-2">
                    <label className="flex items-center gap-2 text-sm text-neu-primary">
                      <input
                        type="checkbox"
                        checked={form.smtpUseTls}
                        onChange={(e) => update("smtpUseTls", e.target.checked)}
                        className="h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
                      />
                      {t("settings.smtpUseTls")}
                    </label>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Delivery log — what the notifier has actually done. */}
        <NotificationDeliveryLog />

        {/* Background Jobs */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.jobsTitle")}</CardTitle>
            <CardDescription>{t("settings.jobsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {jobsLoading ? (
              <div className="space-y-2">
                <div className="skeleton h-4 w-full rounded" />
                <div className="skeleton h-4 w-full rounded" />
                <div className="skeleton h-4 w-2/3 rounded" />
              </div>
            ) : (
              <ul className="space-y-2.5 text-sm">
                {([
                  ["low-stock-scan", t("settings.jobLowStock")],
                  ["maintenance-sweep", t("settings.jobMaintenance")],
                  ["reservation-cleanup", t("settings.jobReservations")],
                ] as const).map(([key, label]) => {
                  const run = jobs[key];
                  return (
                    <li key={key} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-neu-primary">{label}</p>
                        <p
                          className={cn(
                            "mt-0.5 text-xs",
                            run && !run.ok ? "text-neu-ink-red" : "text-neu-faint"
                          )}
                        >
                          {formatJobRun(run)}
                        </p>
                      </div>
                      <span
                        aria-hidden
                        className={cn(
                          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                          !run
                            ? "bg-neu-sunken"
                            : run.ok
                              ? "bg-neu-solid-green"
                            : "bg-neu-solid-red"
                        )}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-neu-faint">{t("settings.jobsScopeNote")}</p>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-neu-hairline bg-neu-sunken p-3">
              <p className="text-xs text-neu-faint max-w-sm">{t("settings.maintenanceRunHint")}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={runMaintenanceNow}
                loading={runningMaintenance}
              >
                {t("settings.maintenanceRunNow")}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.quickActions")}</CardTitle>
            <CardDescription>
              {t("settings.quickActionsDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button variant="secondary" className="w-full justify-start" onClick={exportProducts} loading={exporting}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {t("settings.exportProducts")}
            </Button>
            <a
              href="/settings/audit-log"
              className="flex w-full items-center justify-start gap-2 rounded-lg bg-neu-bg px-3 text-sm font-medium text-neu-primary shadow-sm transition-all hover:bg-neu-sunken border border-neu-hairline h-9"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              {t("settings.auditLog")}
            </a>
            <a
              href="/settings/roles"
              className="flex w-full items-center justify-start gap-2 rounded-lg bg-neu-bg px-3 text-sm font-medium text-neu-primary shadow-sm transition-all hover:bg-neu-sunken border border-neu-hairline h-9"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
              {t("settings.rolesPerms")}
            </a>
            <a
              href="/inventory"
              className="flex w-full items-center justify-start gap-2 rounded-lg bg-neu-bg px-3 text-sm font-medium text-neu-primary shadow-sm transition-all hover:bg-neu-sunken border border-neu-hairline h-9"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              {t("settings.viewLowStock")}
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}