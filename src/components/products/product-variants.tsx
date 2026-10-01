"use client";

import * as React from "react";
import { centsToMajorString } from "@/lib/money/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BarcodeScanner } from "@/components/pos/barcode-scanner";
import { useI18n } from "@/components/providers/i18n-provider";
import { toast } from "@/stores/toast-store";
import { formatCurrency, cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   PRODUCT VARIANTS MANAGEMENT
   Allows adding, editing, and removing product variants
   (e.g. size, color combinations) within the product form.
   Only visible when editing an existing product.
   ═══════════════════════════════════════════════════════════════ */

interface ProductVariant {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  unitPrice: number;
  costPrice: number;
  imageUrl?: string;
  options: string;
  isActive: boolean;
  totalStock: number;
  createdAt: string;
}

interface ProductVariantsProps {
  productId: string;
  parentSku: string;
  parentUnitPrice: number;
  parentCostPrice: number;
}

function parseOptions(options: string): Record<string, string> {
  try {
    const parsed = JSON.parse(options);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch { /* ignore */ }
  return {};
}

function serializeOptions(options: Record<string, string>): string {
  return JSON.stringify(options);
}

export function ProductVariants({
  productId,
  parentSku,
  parentUnitPrice,
  parentCostPrice,
}: ProductVariantsProps) {
  const { t } = useI18n();
  const [variants, setVariants] = React.useState<ProductVariant[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [addOpen, setAddOpen] = React.useState(false);
  const [editVariant, setEditVariant] = React.useState<ProductVariant | null>(null);

  // Add/Edit form state
  const [formName, setFormName] = React.useState("");
  const [formSku, setFormSku] = React.useState("");
  const [formBarcode, setFormBarcode] = React.useState("");
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [formUnitPrice, setFormUnitPrice] = React.useState("");
  const [formCostPrice, setFormCostPrice] = React.useState("");
  const [formOptions, setFormOptions] = React.useState<Record<string, string>>({});
  const [optionKey, setOptionKey] = React.useState("");
  const [optionValue, setOptionValue] = React.useState("");
  const [formSaving, setFormSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  // Duplicate-barcode guard across VARIANTS: two variants sharing a GTIN
  // makes scans ambiguous at the register. Debounced lookup on the variant
  // API for this product; the variant being edited is excluded.
  React.useEffect(() => {
    const code = formBarcode.trim();
    if (!code) {
      setVariantConflict(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/products/${productId}/variants`);
        if (!res.ok) return;
        const data = await res.json();
        const hits = (data.variants ?? [])
          .filter(
            (v: { barcode?: string | null; id: string; name: string }) =>
              v.barcode === code && v.id !== editVariant?.id
          )
          .map((v: { name: string }) => v.name);
        if (!cancelled) setVariantConflict(hits.length > 0 ? hits : null);
      } catch {
        /* network hiccup — server still 409s on a real duplicate SKU */
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formBarcode, productId]);

  const [variantConflict, setVariantConflict] = React.useState<string[] | null>(null);

  // Fetch variants
  const fetchVariants = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/products/${productId}/variants`);
      const data = await res.json();
      setVariants(data.variants ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  React.useEffect(() => {
    fetchVariants();
  }, [fetchVariants]);

  // Open add form
  function openAdd() {
    setFormName("");
    setFormSku(`${parentSku}-`);
    setFormBarcode("");
    setFormUnitPrice(String(centsToMajorString(parentUnitPrice)));
    setFormCostPrice(String(centsToMajorString(parentCostPrice)));
    setFormOptions({});
    setOptionKey("");
    setOptionValue("");
    setEditVariant(null);
    setAddOpen(true);
  }

  // Open edit form
  function openEdit(v: ProductVariant) {
    setFormName(v.name);
    setFormSku(v.sku);
    setFormBarcode(v.barcode ?? "");
    setFormUnitPrice(String(centsToMajorString(v.unitPrice)));
    setFormCostPrice(String(centsToMajorString(v.costPrice)));
    setFormOptions(parseOptions(v.options));
    setOptionKey("");
    setOptionValue("");
    setEditVariant(v);
    setAddOpen(true);
  }

  // Add option
  function addOption() {
    const k = optionKey.trim();
    const val = optionValue.trim();
    if (!k || !val) return;
    setFormOptions((prev) => ({ ...prev, [k]: val }));
    setOptionKey("");
    setOptionValue("");
  }

  // Remove option
  function removeOption(key: string) {
    setFormOptions((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // Save variant (create or update)
  async function handleSave() {
    if (!formName.trim() || !formSku.trim()) {
      toast.error(t("common.error"), t("products.form.nameSkuRequired"));
      return;
    }
    setFormSaving(true);
    try {
      const payload = {
        name: formName.trim(),
        sku: formSku.trim(),
        barcode: formBarcode.trim() || undefined,
        unitPrice: parseFloat(formUnitPrice) || 0,
        costPrice: parseFloat(formCostPrice) || 0,
        options: serializeOptions(formOptions),
      };

      const isEdit = Boolean(editVariant);
      const url = isEdit
        ? `/api/products/${productId}/variants/${editVariant!.id}`
        : `/api/products/${productId}/variants`;

      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(t("common.error"), typeof data.error === "string" ? data.error : undefined);
        return;
      }

      setAddOpen(false);
      setEditVariant(null);
      fetchVariants();
      toast.success(
        isEdit ? t("common.saved") : t("common.created"),
        `${formName} — ${formSku}`
      );
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setFormSaving(false);
    }
  }

  // Delete variant
  async function handleDelete(v: ProductVariant) {
    setDeleting(v.id);
    try {
      const res = await fetch(`/api/products/${productId}/variants/${v.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(t("common.error"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      fetchVariants();
      toast.success(t("common.deleted"), v.name);
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setDeleting(null);
    }
  }

  // Toggle active status
  async function toggleActive(v: ProductVariant) {
    try {
      await fetch(`/api/products/${productId}/variants/${v.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !v.isActive }),
      });
      fetchVariants();
    } catch {
      toast.error(t("common.networkError"));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-neu-hairline pb-2">
        <h4 className="text-sm font-semibold text-neu-primary">
          {t("products.form.variants")}
          {variants.length > 0 && (
            <Badge variant="info" size="sm" className="ms-2">
              {variants.length}
            </Badge>
          )}
        </h4>
        <Button variant="secondary" size="sm" onClick={openAdd}>
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          {t("products.form.addVariant")}
        </Button>
      </div>

      <p className="text-xs text-neu-faint">
        {t("products.form.variantsHint")}
      </p>

      {/* Variant list */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="skeleton h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : variants.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neu-hairline p-6 text-center">
          <p className="text-sm text-neu-faint">{t("products.form.noVariants")}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={openAdd}>
            {t("products.form.addFirstVariant")}
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-neu-hairline rounded-lg border border-neu-hairline">
          {variants.map((v) => {
            const options = parseOptions(v.options);
            return (
              <div key={v.id} className={cn("flex items-center gap-3 px-3 py-2.5 transition-colors", !v.isActive && "opacity-60")}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-neu-primary" title={`${v.name}`}>{v.name}</p>
                    {!v.isActive && (
                      <Badge variant="warning" size="sm">{t("products.inactive")}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-neu-faint">
                    <span className="font-mono">{v.sku}</span>
                    <span>{formatCurrency(v.unitPrice)}</span>
                    <span>{v.totalStock} {t("products.stock")}</span>
                  </div>
                  {Object.keys(options).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {Object.entries(options).map(([k, val]) => (
                        <span key={k} className="inline-flex items-center gap-0.5 rounded bg-neu-sunken px-1.5 py-0.5 text-[10px] font-medium text-neu-muted">
                          {k}: {val}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleActive(v)}
                    title={v.isActive ? t("common.deactivate") : t("common.activate")}
                  >
                    {v.isActive ? (
                      <svg className="h-4 w-4 text-neu-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.5H9.75a2.25 2.25 0 01-2.25-2.25V9.75a2.25 2.25 0 012.25-2.25h4.5a2.25 2.25 0 012.25 2.25v7.125a2.25 2.25 0 01-2.25 2.25h-1.5m-5.25-2.25h3m-3.75 3.75h3m-3.75 3.75h3" />
                      </svg>
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(v)} title={t("common.edit")}>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(v)}
                    loading={deleting === v.id}
                    className="text-neu-ink-red hover:bg-neu-wash-red"
                    title={t("common.delete")}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit Variant Dialog */}
      {addOpen && (
        <Dialog open onOpenChange={() => { setAddOpen(false); setEditVariant(null); }}>
          <DialogContent size="md">
            <DialogHeader>
              <DialogTitle>
                {editVariant ? t("products.form.editVariant") : t("products.form.addVariant")}
              </DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={`${t("products.name")} *`}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Red / Large"
                />
                <Input
                  label="SKU *"
                  value={formSku}
                  onChange={(e) => setFormSku(e.target.value)}
                  placeholder="e.g. SHIRT-RED-L"
                />
              </div>

              <div>
                <Label>{t("products.barcode")}</Label>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    value={formBarcode}
                    onChange={(e) => setFormBarcode(e.target.value)}
                    placeholder="Optional"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setScannerOpen(true)}
                    title={t("products.form.scanBarcode")}
                    aria-label={t("products.form.scanBarcode")}
                  >                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                  </Button>
                </div>
                {/* Duplicate-variant-barcode warning */}
                {variantConflict && variantConflict.length > 0 && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-neu-ink-amber">
                    <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <span>
                      {t("products.form.variantBarcodeInUse")} {variantConflict.join(", ")}
                    </span>
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={`${t("products.form.sellingPrice")} *`}
                  type="number"
                  step="0.01"
                  min="0"
                  value={formUnitPrice}
                  onChange={(e) => setFormUnitPrice(e.target.value)}
                />
                <Input
                  label={`${t("products.form.costPrice")} *`}
                  type="number"
                  step="0.01"
                  min="0"
                  value={formCostPrice}
                  onChange={(e) => setFormCostPrice(e.target.value)}
                />
              </div>

              {/* Variant Options (key-value pairs) */}
              <div>
                <Label>{t("products.form.variantOptions")}</Label>
                <p className="mb-2 text-xs text-neu-faint">{t("products.form.variantOptionsHint")}</p>

                {Object.keys(formOptions).length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {Object.entries(formOptions).map(([k, val]) => (
                      <span key={k} className="option-chip">
                        <span className="font-semibold">{k}:</span> {val}
                        <button
                          onClick={() => removeOption(k)}
                          className="ms-0.5 flex h-4 w-4 items-center justify-center rounded-full text-neu-faint transition-colors hover:bg-neu-wash-red hover:text-neu-ink-red"
                          aria-label={t("common.remove")}
                        >
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <Input
                    placeholder={t("products.form.optionKey")}
                    value={optionKey}
                    onChange={(e) => setOptionKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }}
                    wrapperClassName="flex-1"
                  />
                  <Input
                    placeholder={t("products.form.optionValue")}
                    value={optionValue}
                    onChange={(e) => setOptionValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }}
                    wrapperClassName="flex-1"
                  />
                  <Button variant="secondary" size="sm" onClick={addOption} disabled={!optionKey.trim() || !optionValue.trim()}>
                    +
                  </Button>
                </div>
              </div>
            </DialogBody>

            <DialogFooter>
              <Button variant="secondary" onClick={() => { setAddOpen(false); setEditVariant(null); }}>
                {t("common.cancel")}
              </Button>
              <Button loading={formSaving} onClick={handleSave}>
                {editVariant ? t("settings.save") : t("products.form.addVariant")}
              </Button>
            </DialogFooter>

            {/* Barcode scanner dialog — camera scan fills the variant's barcode */}
            <Dialog open={scannerOpen} onOpenChange={setScannerOpen}>
              <DialogContent size="md">
                <DialogHeader>
                  <DialogTitle>{t("products.form.scanBarcode")}</DialogTitle>
                </DialogHeader>
                <DialogBody>
                  <BarcodeScanner
                    onScan={(value) => {
                      setFormBarcode(value);
                      setScannerOpen(false);
                      toast.success(t("products.form.barcodeDetected"), value);
                    }}
                    onClose={() => setScannerOpen(false)}
                  />
                </DialogBody>
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
