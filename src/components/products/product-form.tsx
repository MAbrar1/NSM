"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { productSchema, type ProductInput } from "@/lib/validations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BarcodeScanner } from "@/components/pos/barcode-scanner";
import { barcodeCandidates, generateEan13 } from "@/lib/products/barcode";
import { COMMON_UNITS } from "@/lib/products/units";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { ProductVariants } from "@/components/products/product-variants";
import { ImageGalleryUpload } from "@/components/products/image-gallery-upload";
import { toast } from "@/stores/toast-store";

/* Common sub-unit pairs offered as quick-add chips for loose goods.
 * factor = how many base units equal ONE sub-unit (1 g = 0.001 kg). */
const QUICK_CONVERSIONS: Record<string, Array<{ unit: string; factor: number }>> = {
  kg: [{ unit: "g", factor: 0.001 }],
  g: [{ unit: "kg", factor: 1000 }],
  L: [{ unit: "ml", factor: 0.001 }],
  ml: [{ unit: "L", factor: 1000 }],
};

/* ═══════════════════════════════════════════════════════════════
   PRODUCT FORM
   Reusable form component for creating and editing products.
   Handles validation, API calls, and error display.
   ═══════════════════════════════════════════════════════════════ */

interface Category {
  id: string;
  name: string;
  _count?: { products: number };
}

interface ProductFormProps {
  initialData?: Partial<ProductInput> & { id?: string; images?: string[] };
  categories: Category[];
  onSuccess: () => void;
  onCancel: () => void;
  /** Prefill the barcode field (scan-to-create hand-off from the POS). */
  prefillBarcode?: string;
}

export function ProductForm({
  initialData,
  categories,
  onSuccess,
  onCancel,
  prefillBarcode,
}: ProductFormProps) {
  const { t } = useI18n();
  const baseCurrency = useStoreCurrency();
  const [loading, setLoading] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Record<string, string[]>>({});
  const [brands, setBrands] = React.useState<Array<{ id: string; name: string }>>([]);
  const [scannerOpen, setScannerOpen] = React.useState(false);

  // Unit conversions (sub-units of the base unit, e.g. kg ⇄ g). Kept in
  // local state and merged into the payload on submit — the schema stores
  // them as a JSON array and the POS uses them for unit-aware quantity dialogs.
  const [conversions, setConversions] = React.useState<Array<{ unit: string; factor: number }>>(
    () =>
      Array.isArray(initialData?.unitConversions)
        ? initialData.unitConversions.filter((c) => c && typeof c.unit === "string")
        : []
  );
  const [convUnit, setConvUnit] = React.useState("");
  const [convFactor, setConvFactor] = React.useState("");

  // Load available brands for the brand selector
  React.useEffect(() => {
    fetch("/api/brands")
      .then((r) => r.json())
      .then((d) => setBrands(d.brands ?? []))
      .catch(() => {});
  }, []);

  const isEditing = Boolean(initialData?.id);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProductInput>({
    resolver: zodResolver(productSchema) as any,
    defaultValues: {
      name: initialData?.name ?? "",
      sku: initialData?.sku ?? "",
      barcode: initialData?.barcode ?? prefillBarcode ?? "",
      description: initialData?.description ?? "",
      categoryId: initialData?.categoryId ?? "",
      brandId: initialData?.brandId ?? "",
      unitPrice: initialData?.unitPrice ?? 0,
      costPrice: initialData?.costPrice ?? 0,
      compareAtPrice: initialData?.compareAtPrice,
      taxRate: initialData?.taxRate ?? 0,
      status: initialData?.status ?? "active",
      trackInventory: initialData?.trackInventory ?? true,
      allowDiscount: initialData?.allowDiscount ?? true,
      minStockLevel: initialData?.minStockLevel ?? 5,
      maxStockLevel: initialData?.maxStockLevel ?? undefined,
      unit: initialData?.unit ?? "pcs",
      allowFractional: initialData?.allowFractional ?? false,
      sellByValue: initialData?.sellByValue ?? false,
    },    });

  // ─── Duplicate-barcode guard ──────────────────────────────
  // A barcode must identify exactly one product: if the cashier scans
  // or types one already assigned to ANOTHER product, surface a clear,
  // actionable warning before the confusing 409 ever happens. Checked
  // through the shared /api/products/lookup (exact barcode match, GTIN
  // candidate aware). Skipped for the product being edited itself.
  const barcodeValue = watch("barcode");
  const [barcodeConflict, setBarcodeConflict] = React.useState<
    Array<{ name: string; sku: string }> | null
  >(null);
  React.useEffect(() => {
    const code = (barcodeValue ?? "").trim();
    if (!code || code === (initialData?.barcode ?? "")) {
      setBarcodeConflict(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/products/lookup?q=${encodeURIComponent(code)}`);
        if (!res.ok) return;
        const data = await res.json();
        const hits: Array<{ name: string; sku: string }> = (data.products ?? [])
          .filter(
            (p: { barcode?: string | null }) =>
              p.barcode && barcodeCandidates(code).includes(p.barcode)
          )
          .map((p: { name: string; sku: string }) => ({ name: p.name, sku: p.sku }));
        if (!cancelled) setBarcodeConflict(hits.length > 0 ? hits : null);
      } catch {
        /* network hiccup — the server still validates on submit */
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barcodeValue]);

  function addConversion() {
    const unit = convUnit.trim().toLowerCase();
    const factor = parseFloat(convFactor);
    if (!unit || !Number.isFinite(factor) || factor <= 0) {
      toast.error(t("common.error"), t("products.form.conversionInvalid"));
      return;
    }
    if (unit === (initialData?.unit ?? "pcs")) {
      toast.error(t("common.error"), t("products.form.conversionBaseUnit"));
      return;
    }
    if (conversions.some((c) => c.unit === unit)) {
      toast.error(t("common.error"), t("products.form.conversionExists"));
      return;
    }
    setConversions((prev) => [...prev, { unit, factor }]);
    setConvUnit("");
    setConvFactor("");
  }

  function removeConversion(index: number) {
    setConversions((prev) => prev.filter((_, i) => i !== index));
  }

  async function onSubmit(data: ProductInput) {
    setLoading(true);
    setServerErrors({});

    try {
      const url = isEditing
        ? `/api/products/${initialData!.id}`
        : "/api/products";

      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          // Merge the conversion editor state into the validated payload
          unitConversions: conversions.length > 0 ? conversions : undefined,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        if (typeof result.error === "object") {
          setServerErrors(result.error as Record<string, string[]>);
        } else {
          setServerErrors({ _form: [result.error || t("products.form.genericError")] });
        }
        return;
      }

      onSuccess();
    } catch {
      setServerErrors({ _form: [t("common.networkErrorDesc")] } as Record<string, string[]>);
    } finally {
      setLoading(false);
    }
  }

  return (
    /* The form owns the dialog chrome (header/body/footer). It is rendered
       as the sole child of DialogContent, so the scroll shim leaves it
       untouched and the footer stays genuinely pinned while DialogBody —
       the only scrollable region — scrolls. Previously the shim wrapped
       the whole form in a second padded DialogBody, double-padding the
       fields and letting the "sticky" footer scroll out of view. */
    <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>{isEditing ? t("products.editProduct") : t("products.addProduct")}</DialogTitle>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 space-y-4">
      {/* Global Error */}
      {serverErrors["_form"] && (
        <div className="rounded-lg border border-neu-ink-red/20 bg-neu-wash-red p-3 text-sm text-neu-ink-red">
          {serverErrors["_form"].join(", ")}
        </div>
      )}

      {/* Basic Info */}
      <div className="space-y-4">
        <div className="form-section">
          <h4 className="form-section-title mb-3">{t("products.form.basicInfo")}</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={`${t("products.name")} *`}
              placeholder={t("products.form.namePlaceholder")}
              error={(errors.name?.message as string) || serverErrors["name"]?.join(", ")}
              {...register("name")}
            />
            <Input
              label="SKU *"
              placeholder={t("products.form.skuPlaceholder")}
              error={(errors.sku?.message as string) || serverErrors["sku"]?.join(", ")}
              {...register("sku")}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>{t("products.barcode")}</Label>
              <div className="mt-1.5 flex items-center gap-2">
                <Input
                  placeholder={t("products.form.barcodePlaceholder")}
                  error={errors.barcode?.message as string | undefined}
                  {...register("barcode")}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setScannerOpen(true)}
                  title={t("products.form.scanBarcode")}
                  aria-label={t("products.form.scanBarcode")}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                </Button>
                {/* Generate a valid in-store EAN-13 (GS1 200–299 band) for
                    house products without a manufacturer barcode */}
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  onClick={() => {
                    const code = generateEan13();
                    setValue("barcode", code, { shouldValidate: true, shouldDirty: true });
                    toast.success(t("products.form.barcodeGenerated"), code);
                  }}
                  title={t("products.form.generateBarcode")}
                  aria-label={t("products.form.generateBarcode")}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                  </svg>
                </Button>
              </div>
              {/* Duplicate-barcode warning — actionable before submit */}
              {barcodeConflict && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-neu-ink-amber">
                  <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <span>
                    {t("products.form.barcodeInUse")}{" "}
                    {barcodeConflict.map((c) => `${c.name} (${c.sku})`).join(", ")}
                  </span>
                </p>
              )}
            </div>
            <div>
              <Label>{`${t("products.category")} *`}</Label>
              <select
                className="mt-1.5 flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary transition-colors neu-focus"
                {...register("categoryId")}
              >
                <option value="">{t("products.form.selectCategory")}</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
              {errors.categoryId && (
                <p className="mt-1 text-xs text-neu-ink-red">{(errors.categoryId.message as string) ?? ""}</p>
              )}
            </div>
            <div>
              <Label>{t("products.brand")}</Label>
              <select
                className="mt-1.5 flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary transition-colors neu-focus"
                {...register("brandId")}
              >
                <option value="">{t("products.form.noBrand")}</option>
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Input
            label={t("products.description")}
            placeholder={t("products.form.descriptionPlaceholder")}
            error={errors.description?.message as string | undefined}
            {...register("description")}
          />
        </div>
      </div>

      {/* Pricing */}
      <div className="space-y-3">
        <div className="form-section">
          <h4 className="form-section-title mb-3">{t("products.form.pricing")}</h4>
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label={`${t("products.form.sellingPrice")} * (${baseCurrency})`}
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              error={errors.unitPrice?.message as string | undefined}
              {...register("unitPrice", { valueAsNumber: true })}
            />
            <Input
              label={`${t("products.form.costPrice")} * (${baseCurrency})`}
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              error={errors.costPrice?.message as string | undefined}
              {...register("costPrice", { valueAsNumber: true })}
            />
            <Input
              label={`${t("products.form.compareAtPrice")} (${baseCurrency})`}
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              hint={t("products.form.compareAtHint")}
              error={errors.compareAtPrice?.message as string | undefined}
              {...register("compareAtPrice", {
                // Optional: an empty field must stay undefined — valueAsNumber
                // turns "" into NaN which zod then rejects with a raw error.
                setValueAs: (v) => (v === "" || v === undefined ? undefined : Number(v)),
              })}
            />
          </div>
        </div>
      </div>

      {/* Inventory */}
      <div className="space-y-3">
        <div className="form-section">
          <h4 className="form-section-title mb-3">{t("products.form.inventory")}</h4>
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label={t("products.form.taxRate")}
              type="number"
              step="0.01"
              min="0"
              max="100"
              placeholder="0"
              error={errors.taxRate?.message as string | undefined}
              {...register("taxRate", { valueAsNumber: true })}
            />
            <Input
              label={t("products.form.minStock")}
              type="number"
              min="0"
              placeholder="5"
              error={errors.minStockLevel?.message as string | undefined}
              {...register("minStockLevel", { valueAsNumber: true })}
            />
            <Input
              label={t("products.form.maxStock")}
              type="number"
              min="0"
              placeholder="Optional"
              error={errors.maxStockLevel?.message as string | undefined}
              {...register("maxStockLevel", {
                // Optional: an empty field must stay undefined, not NaN
                setValueAs: (v) => (v === "" || v === undefined ? undefined : Number(v)),
              })}
            />
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-neu-primary">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
                {...register("trackInventory")}
              />
              {t("products.form.trackInventory")}
            </label>
            <label className="flex items-center gap-2 text-sm text-neu-primary">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
                {...register("allowDiscount")}
              />
              {t("products.form.allowDiscount")}
            </label>
          </div>
        </div>
      </div>

      {/* Units & Selling (multi-unit support) */}
      <div className="space-y-3">
        <div className="form-section">
          <h4 className="form-section-title mb-3">{t("products.form.unitsAndSelling")}</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>{`${t("products.form.baseUnit")} *`}</Label>
              <select
                className="mt-1.5 flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary neu-focus"
                {...register("unit")}
              >
                {!COMMON_UNITS.includes((initialData?.unit ?? "pcs") as (typeof COMMON_UNITS)[number]) && (
                  <option value={initialData?.unit ?? "pcs"}>{initialData?.unit ?? "pcs"}</option>
                )}
                {COMMON_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-neu-faint">{t("products.form.baseUnitHint")}</p>
            </div>
            <div className="space-y-3">
              <label className="flex items-start gap-2 text-sm text-neu-primary">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
                  {...register("allowFractional")}
                />
                <span>
                  <span className="font-medium">{t("products.form.allowFractional")}</span>
                  <span className="block text-xs text-neu-faint">{t("products.form.allowFractionalHint")}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-neu-primary">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-neu-hairline text-neu-accent-ink neu-focus"
                  {...register("sellByValue")}
                />
                <span>
                  <span className="font-medium">{t("products.form.sellByValue")}</span>
                  <span className="block text-xs text-neu-faint">{t("products.form.sellByValueHint")}</span>
                </span>
              </label>
            </div>
          </div>

          {/* Unit conversions (sub-units of the base unit) */}
          <div className="mt-3 rounded-lg border border-neu-hairline bg-neu-sunken/50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-neu-primary">
                {t("products.form.unitConversions")}
              </p>
              <p className="text-[11px] text-neu-faint">{t("products.form.unitConversionsHint")}</p>
            </div>

            {conversions.length === 0 ? (
              <p className="mt-2 text-xs text-neu-faint">{t("products.form.noConversions")}</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {conversions.map((c, idx) => (
                  <div key={`${c.unit}-${idx}`} className="flex items-center gap-2 text-sm">
                    <span className="conv-chip">
                      {c.unit}
                    </span>
                    <span className="text-neu-faint">=</span>
                    <span className="tabular-nums text-neu-muted">
                      {c.factor} {initialData?.unit ?? "pcs"}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeConversion(idx)}
                      className="ms-auto flex h-5 w-5 items-center justify-center rounded text-neu-faint transition-colors hover:bg-neu-wash-red hover:text-neu-ink-red"
                      aria-label="Remove conversion"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Quick-add chips for common pairs */}
            {(() => {
              const quickChips = QUICK_CONVERSIONS[initialData?.unit ?? "pcs"] ?? [];
              if (quickChips.length === 0) return null;
              return (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {quickChips
                    .filter((qc) => !conversions.some((c) => c.unit === qc.unit))
                    .map((qc) => (
                      <button
                        key={qc.unit}
                        type="button"
                        onClick={() => setConversions((prev) => [...prev, qc])}
                        className="quick-conv-chip"
                      >
                        + {qc.unit} ({qc.factor} {initialData?.unit ?? "pcs"})
                      </button>
                    ))}
                </div>
              );
            })()}

            <div className="mt-3 flex items-end gap-2">
              <div className="w-28">
                <Label>{t("products.form.conversionUnit")}</Label>
                <input
                  type="text"
                  value={convUnit}
                  onChange={(e) => setConvUnit(e.target.value)}
                  placeholder="g"
                  className="mt-1.5 flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary placeholder:text-neu-faint neu-focus"
                />
              </div>
              <div className="flex-1">
                <Label>{t("products.form.conversionFactor")}</Label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={convFactor}
                  onChange={(e) => setConvFactor(e.target.value)}
                  placeholder="0.001"
                  className="mt-1.5 flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary placeholder:text-neu-faint neu-focus"
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addConversion}
                disabled={!convUnit.trim() || !convFactor.trim()}
              >
                +
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="space-y-3">
        <div className="form-section">
          <h4 className="form-section-title mb-3">{t("products.status")}</h4>
          <select
            className="flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary transition-colors neu-focus"
            {...register("status")}
          >
            <option value="active">{t("products.active")}</option>
            <option value="inactive">{t("products.inactive")}</option>
            <option value="discontinued">{t("products.discontinued")}</option>
          </select>
        </div>
      </div>

      {/* Product Images (only when editing an existing product) */}
      {isEditing && initialData?.id && (
        <div className="space-y-3">
          <div className="form-section">
            <h4 className="form-section-title mb-3">{t("products.form.images")}</h4>
            <ImageGalleryUpload
              productId={initialData.id}
              existingImages={initialData.images ?? []}
              maxImages={6}
              onImagesChange={(images) => {
                // Persist reorders/removals to the gallery endpoint
                fetch(`/api/products/${initialData.id}/image`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ images }),
                }).catch(() => {});
              }}
            />
          </div>
        </div>
      )}

      {/* Variants (only when editing an existing product) */}
      {isEditing && initialData?.id && (
        <div className="space-y-3">
          <div className="form-section">
            <h4 className="form-section-title mb-3">{t("products.form.variants")}</h4>
            <ProductVariants
              productId={initialData.id}
              parentSku={initialData?.sku ?? ""}
              parentUnitPrice={initialData?.unitPrice ?? 0}
              parentCostPrice={initialData?.costPrice ?? 0}
            />
          </div>
        </div>
      )}

      {/* Barcode scanner dialog — camera scan fills the barcode field */}
      <Dialog open={scannerOpen} onOpenChange={setScannerOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("products.form.scanBarcode")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <BarcodeScanner
              onScan={(value) => {
                setValue("barcode", value, { shouldValidate: true, shouldDirty: true });
                setScannerOpen(false);
                toast.success(t("products.form.barcodeDetected"), value);
              }}
              onClose={() => setScannerOpen(false)}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>

      </DialogBody>

      {/* Action bar — pinned below the scrollable body */}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={loading}>
          {isEditing ? t("settings.save") : t("products.addProduct")}
        </Button>
      </DialogFooter>
    </form>
  );
}
