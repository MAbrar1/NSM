"use client";

import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { readApiError } from "@/lib/api-error";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { toast } from "@/stores/toast-store";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   RECEIPT SETTINGS PAGE
   Customize receipt header/footer and low-stock threshold
   with a live 80mm receipt preview.
   ═══════════════════════════════════════════════════════════════ */

export default function ReceiptSettingsPage() {
  const { t } = useI18n();
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [dirty, setDirty] = React.useState(false);
  // Shield the unsaved edits: beforeunload + in-app leave confirmation
  // (the DirtyNavGuard in the dashboard layout does the actual blocking).
  useUnsavedGuard({ when: dirty });
  const [storeName, setStoreName] = React.useState("");
  const [storeAddress, setStoreAddress] = React.useState("");
  const [storePhone, setStorePhone] = React.useState("");
  const [storeEmail, setStoreEmail] = React.useState("");
  const [receiptHeader, setReceiptHeader] = React.useState("");
  const [receiptFooter, setReceiptFooter] = React.useState("");
  const [receiptQrPayment, setReceiptQrPayment] = React.useState("");
  const [lowStockThreshold, setLowStockThreshold] = React.useState(5);
  const [taxRate, setTaxRate] = React.useState(0);
  const [taxInclusive, setTaxInclusive] = React.useState(false);
  const [currency, setCurrency] = React.useState("USD");

  React.useEffect(() => {
    setLoadError(false);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings;
        if (!s) return;
        setStoreName(s.storeName ?? "");
        setStoreAddress(s.storeAddress ?? "");
        setStorePhone(s.storePhone ?? "");
        setStoreEmail(s.storeEmail ?? "");
        setReceiptHeader(s.receiptHeader ?? "");
        setReceiptFooter(s.receiptFooter ?? "");
        setReceiptQrPayment(s.receiptQrPayment ?? "");
        setLowStockThreshold(s.lowStockThreshold ?? 5);
        setTaxRate(s.taxRate ?? 0);
        setTaxInclusive(s.taxInclusive ?? false);
        setCurrency(s.currency ?? "USD");
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

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeName,
          storeAddress,
          storePhone,
          storeEmail,
          receiptHeader,
          receiptFooter,
          receiptQrPayment,
          lowStockThreshold,
          taxRate,
          taxInclusive,
          currency,
        }),
      });
      if (!res.ok) {
        // Field-keyed errors underline the offending input; a plain string
        // (permission, 500) has no field to attach to, so it toasts.
        const { fields, message } = await readApiError(res, t("settings.saveFailed"));
        setFieldErrors(fields);
        if (Object.keys(fields).length === 0) toast.error(message);
        return;
      }
      setFieldErrors({});
      setDirty(false);
      toast.success(t("receiptSettings.saved"));
    } catch {
      toast.error(t("settings.networkError"), t("settings.networkErrorDesc"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-8 w-48 rounded" />
        <div className="grid gap-6 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6 space-y-3">
                <div className="skeleton h-4 w-32 rounded" />
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
          title={t("receiptSettings.title")}
          description={t("receiptSettings.description")}
          breadcrumbs={[
            { label: t("settings.title"), href: "/settings" },
            { label: t("receiptSettings.breadcrumb") },
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
        title={t("receiptSettings.title")}
        description={t("receiptSettings.description")}
        breadcrumbs={[
          { label: t("settings.title"), href: "/settings" },
          { label: t("receiptSettings.breadcrumb") },
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

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Editor */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("receiptSettings.contentTitle")}</CardTitle>
              <CardDescription>
                {t("receiptSettings.contentDesc")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label={t("receiptSettings.storeNameHeader")}
                placeholder={t("receiptSettings.storeNamePlaceholder")}
                value={storeName}
                error={fieldErrors["storeName"]}
                onChange={(e) => { setStoreName(e.target.value); setDirty(true); setFieldErrors((p) => { const n = { ...p }; delete n["storeName"]; return n; }); }}
              />
              <Input
                label={t("settings.receiptHeader")}
                placeholder={t("settings.receiptHeaderPlaceholder")}
                value={receiptHeader}
                onChange={(e) => { setReceiptHeader(e.target.value); setDirty(true); }}
              />
              <Input
                label={t("settings.receiptFooter")}
                placeholder={t("settings.receiptFooterPlaceholder")}
                value={receiptFooter}
                onChange={(e) => { setReceiptFooter(e.target.value); setDirty(true); }}
              />
              <Input
                label={t("settings.receiptQrPayment")}
                placeholder={t("settings.receiptQrPlaceholder")}
                value={receiptQrPayment}
                onChange={(e) => { setReceiptQrPayment(e.target.value); setDirty(true); }}
                hint={t("settings.receiptQrHint")}
              />
              <Input
                label={t("settings.lowStockThreshold")}
                type="number"
                value={String(lowStockThreshold)}
                min="0"
                error={fieldErrors["lowStockThreshold"]}
                onChange={(e) => { setLowStockThreshold(parseInt(e.target.value) || 0); setDirty(true); setFieldErrors((p) => { const n = { ...p }; delete n["lowStockThreshold"]; return n; }); }}
                hint={t("settings.lowStockHint")}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("receiptSettings.printerTips")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-neu-muted">
              <p>{t("receiptSettings.printerTip1")}</p>
              <p>{t("receiptSettings.printerTip2")}</p>
              <p>{t("receiptSettings.printerTip3")}</p>
            </CardContent>
          </Card>
        </div>

        {/* Live Preview */}
        <div>
          <p className="mb-2 text-sm font-medium text-neu-primary">{t("receiptSettings.livePreview")}</p>
          {/* LTR island — same reason as the POS receipt preview: the thermal receipt
              (print-pos-receipt.ts) is `lang="en"` with physical ink geometry, so the
              facsimile must not mirror when the UI does, or the `justify-between` rows
              would swap label and amount away from what the printer produces. */}
          <div dir="ltr" className="mx-auto w-72 rounded-lg border border-neu-hairline bg-neu-bg p-4 shadow-sm font-mono text-[11px] text-neu-primary">
            <div className="text-center border-b border-dashed border-neu-hairline pb-2 mb-2">
              <p className="font-bold text-sm">{storeName || t("receiptSettings.yourStore")}</p>
              {storeAddress && <p className="text-neu-faint">{storeAddress}</p>}
              {(storePhone || storeEmail) && (
                <p className="text-neu-faint">
                  {[storePhone, storeEmail].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <div className="text-center text-neu-faint">
              <p>{new Date().toLocaleString()}</p>
              <p>{t("receiptSettings.receiptNo")} POS-0001</p>
            </div>
            {receiptHeader && (
              <p className="mt-2 text-center text-neu-muted">{receiptHeader}</p>
            )}
            <div className="mt-2 border-t border-dashed border-neu-hairline pt-2 space-y-1">
              <div className="flex justify-between"><span>Item A × 2</span><span>9.98</span></div>
              <div className="flex justify-between"><span>Item B × 1</span><span>4.99</span></div>
              <div className="flex justify-between"><span>Item C × 3</span><span>11.97</span></div>
            </div>
            <div className="mt-2 border-t border-dashed border-neu-hairline pt-2 space-y-0.5">
              <div className="flex justify-between"><span>{t("pos.subtotal")}</span><span>26.94</span></div>
              <div className="flex justify-between"><span>{t("pos.tax")} ({taxRate}%)</span><span>{(26.94 * taxRate / 100).toFixed(2)}</span></div>
              <div className="flex justify-between font-bold"><span>{t("pos.total")}</span><span>{(26.94 * (1 + taxRate / 100)).toFixed(2)}</span></div>
              <div className="flex justify-between"><span>{t("receiptSettings.paid")}</span><span>30.00</span></div>
              <div className="flex justify-between text-neu-ink-green"><span>{t("pos.change")}</span><span>{(30 - 26.94 * (1 + taxRate / 100)).toFixed(2)}</span></div>
            </div>
            {receiptFooter && (
              <p className="mt-2 text-center text-neu-muted">{receiptFooter}</p>
            )}
            {receiptQrPayment.trim() && (
              <div className="mt-2 border-t border-dashed border-neu-hairline pt-2 text-center">
                <div className="mx-auto grid h-14 w-14 grid-cols-7 gap-px" aria-hidden>
                  {Array.from({ length: 49 }).map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        "aspect-square",
                        (i * 7 + ((i / 7) | 0) + receiptQrPayment.length) % 3 === 0 ? "bg-neu-primary" : "bg-neu-bg"
                      )}
                    />
                  ))}
                </div>
                <p className="mt-1 text-[9px] text-neu-faint">{t("settings.receiptQrCaption")}</p>
              </div>
            )}
            <div className="mt-2 text-center text-neu-faint">
              <p>{t("receiptSettings.thankYou")}</p>
              <p>{currency} · {taxInclusive ? t("receiptSettings.taxIncluded") : t("receiptSettings.taxAdded")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}