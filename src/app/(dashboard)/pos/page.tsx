"use client";

import { useSession } from "next-auth/react";

import * as React from "react";
import { cn, formatCurrency } from "@/lib/utils";
import { displayMajorToBaseCents, baseCentsToDisplayMajorStr, isDisplayConverted, getDisplayCurrency } from "@/lib/money/currency-core";
import { ensureRates, peekRates } from "@/lib/money/currency";
import type { CartItem } from "@/types";
import { useCartStore } from "@/stores/cart-store";
import { useWarehouseStore } from "@/stores/warehouse-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { toast } from "@/stores/toast-store";
import { SmartImage } from "@/components/ui/smart-image";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { printPOSReceipt } from "@/lib/receipts/print-pos-receipt";
import {
  getSaleUnits,
  lineQtyLabel,
  quantityForValue,
  smartQtyParts,
  toBaseQty,
  trimNumber,
  WHOLE_UNITS,
} from "@/lib/products/units";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BarcodeScanner } from "@/components/pos/barcode-scanner";
import { parseScan, barcodeCandidates } from "@/lib/products/barcode";
import { useHardwareScanner } from "@/hooks/use-hardware-scanner";
import { SortableTh } from "@/components/ui/sortable-th";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { CustomerPicker, type PickedCustomer } from "@/components/pos/customer-picker";
import { useStockSync, broadcastStockChange } from "@/hooks/use-stock-sync";
import { resolvePayment, isPartialPaymentAllowed } from "@/lib/money/payment-math";

/* ═══════════════════════════════════════════════════════════════
   POS (POINT OF SALE) PAGE
   Classic terminal layout: products left, live cart right.
   - Barcode/name search with instant results + keyboard nav (↑↓↵)
   - Product browse grid with category chips + real images
   - Live cart with quantity/discount controls and totals
   - Cash/card/wallet payment with change calculation
   - Branded receipt generation + print-friendly rendering
   ═══════════════════════════════════════════════════════════════ */

interface POSProduct {
  id: string;
  name: string;
  sku: string;
  barcode?: string | null;
  description?: string | null;
  categoryName?: string | null;
  imageUrl?: string | null;
  unitPrice: number;
  costPrice: number;
  taxRate: number;
  // Multi-unit metadata
  unit?: string | null;
  allowFractional?: boolean;
  sellByValue?: boolean;
  unitConversions?: string | null;
  // Stock info - consistent with /api/products
  totalStock: number;
  totalReserved: number;
  totalAvailable: number;
  // Shared stock classification (lib/stock-status) from the API
  minStockLevel?: number;
  stockStatus?: "out" | "low" | "ok";
  // Warehouse-specific stock (when warehouseId is provided)
  warehouseId?: string | null;
  warehouseName?: string | null;
  stock: number;  // Warehouse-specific or default warehouse stock
  reserved: number;
  available: number;
  // Active variants — each sellable as its own cart line (own price/SKU/
  // barcode/stock). Checkout decrements variant stock rows, so a scanned
  // or picked variant must carry variantId all the way through.
  variants: POSVariant[];
}

interface POSVariant {
  id: string;
  name: string;
  sku: string;
  barcode?: string | null;
  unitPrice: number;
  costPrice: number;
  totalStock: number;
  totalAvailable: number;
  stock: number;
  available: number;
}

interface CompletedOrder {
  id: string;
  orderNumber: string;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  paidAmount: number;
  changeDue: number;
  /** Cents the customer still owes on this order (credit sale). */
  dueAmount?: number;
  /** paid | partial | unpaid — mirrors the order record. */
  paymentStatus?: string;
  loyaltyRedeemed?: number;
  loyaltyPointsRedeemed?: number;
  items: Array<{
    productName: string;
    quantity: number;
    unit?: string | null;
    unitPrice: number;
    total: number;
  }>;
  createdAt: string;
  paymentMethod: string;
  user?: { name: string } | null;
  customer?: { name: string; email?: string; outstandingBalance?: number } | null;
}

/* ─── Payment method icons (inline SVG, replaces emoji) ─── */

const PAYMENT_METHOD_ICONS: Record<string, string> = {
  cash: "M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z",
  credit_card: "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z",
  debit_card: "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z",
  digital_wallet: "M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3",
  bank_transfer: "M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75z",
};

function PaymentMethodIcon({ id, className }: { id: string; className?: string }) {
  const path = PAYMENT_METHOD_ICONS[id] ?? PAYMENT_METHOD_ICONS["credit_card"]!;
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

/* ─── Star glyph (SVG) — replaces emoji stars for crisp, theme-aware rendering ─── */

function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.958a1 1 0 00.95.69h4.162c.969 0 1.371 1.24.588 1.81l-3.367 2.446a1 1 0 00-.363 1.118l1.286 3.958c.3.922-.755 1.688-1.539 1.118l-3.367-2.446a1 1 0 00-1.175 0l-3.367 2.446c-.783.57-1.838-.196-1.538-1.118l1.285-3.958a1 1 0 00-.363-1.118L2.98 9.385c-.783-.57-.38-1.81.588-1.81h4.163a1 1 0 00.95-.69l1.286-3.958z" />
    </svg>
  );
}

/* ─── API → POSProduct mapper (single source of truth) ───
   Both the browse grid and the live search used to hand-roll this
   mapping with slightly different fallbacks, so the same product could
   show different stock depending on how it was found. One mapper =
   identical numbers everywhere. */
function mapPosProduct(p: Record<string, unknown>): POSProduct {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const variants = Array.isArray(p["variants"])
    ? (p["variants"] as Record<string, unknown>[]).map((v) => ({
        id: String(v["id"] ?? ""),
        name: String(v["name"] ?? ""),
        sku: String(v["sku"] ?? ""),
        barcode: str(v["barcode"]),
        unitPrice: num(v["unitPrice"]),
        costPrice: num(v["costPrice"]),
        totalStock: num(v["totalStock"]),
        totalAvailable: typeof v["totalAvailable"] === "number" ? (v["totalAvailable"] as number) : num(v["totalStock"]),
        stock: num(v["stock"]),
        available: typeof v["available"] === "number" ? (v["available"] as number) : num(v["stock"]),
      }))
    : [];
  const totalStock = num(p["totalStock"]);
  const stock = num(p["stock"]);
  return {
    id: String(p["id"] ?? ""),
    name: String(p["name"] ?? ""),
    sku: String(p["sku"] ?? ""),
    barcode: str(p["barcode"]),
    description: str(p["description"]),
    categoryName: str(p["categoryName"]),
    imageUrl: str(p["imageUrl"]),
    unitPrice: num(p["unitPrice"]),
    costPrice: num(p["costPrice"]),
    taxRate: num(p["taxRate"]),
    unit: str(p["unit"]),
    allowFractional: Boolean(p["allowFractional"]),
    sellByValue: Boolean(p["sellByValue"]),
    unitConversions: str(p["unitConversions"]),
    totalStock,
    totalReserved: num(p["totalReserved"]),
    totalAvailable: typeof p["totalAvailable"] === "number" ? (p["totalAvailable"] as number) : totalStock,
    minStockLevel: typeof p["minStockLevel"] === "number" ? (p["minStockLevel"] as number) : undefined,
    stockStatus:
      p["stockStatus"] === "low" || p["stockStatus"] === "out" || p["stockStatus"] === "ok"
        ? p["stockStatus"]
        : undefined,
    warehouseId: str(p["warehouseId"]),
    warehouseName: str(p["warehouseName"]),
    stock,
    reserved: num(p["reserved"]),
    available: typeof p["available"] === "number" ? (p["available"] as number) : stock,
    variants,
  };
}

/* ─── Product thumbnail with graceful fallback ───
    Delegates to the shared SmartImage renderer so every thumb —
    whatever the uploaded image's height/width — gets the same
    perfect fit: smart crop, letterbox for extreme ratios,
    transparent-friendly backdrop, broken-file fallback. */

function ProductThumb({
  src,
  name,
  className,
  iconClassName,
}: {
  src?: string | null;
  name: string;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <SmartImage
      src={src}
      alt={name}
      className={className}
      iconClassName={iconClassName}
      zoomOnHover={false}
    />
  );
}

/* ─── Unit helpers ─── */

/** Is this product sold as indivisible whole units (pcs/dozen/box)? */
function isWholeUnitProduct(p: { unit?: string | null; allowFractional?: boolean }): boolean {
  const unit = p.unit || "pcs";
  return !p.allowFractional && WHOLE_UNITS.has(unit);
}

/** Short "per unit" suffix for a price, e.g. " / kg" (blank for pcs). */
function perUnitSuffix(unit?: string | null): string {
  const u = unit || "pcs";
  return WHOLE_UNITS.has(u) ? "" : ` / ${u}`;
}

/** Quantity shown in a stock chip / column ("38 kg", "12 left"). */
function stockQtyText(qty: number, unit?: string | null): string {
  const u = unit || "pcs";
  return WHOLE_UNITS.has(u) ? `${trimNumber(qty)}` : `${trimNumber(qty)} ${u}`;
}

/* ─── Quantity stepper (shared by all cart rows) ─── */

function QtyStepper({
  quantity,
  onDec,
  onInc,
  size = "md",
}: {
  quantity: number;
  onDec: () => void;
  onInc: () => void;
  size?: "sm" | "md";
}) {
  const btn = cn(
    "flex items-center justify-center rounded-md border border-neu-hairline text-neu-muted transition-colors hover:bg-neu-sunken active:scale-95",
    size === "sm" ? "h-6 w-6" : "h-7 w-7"
  );
  return (
    <div className="flex items-center gap-1">
      <button onClick={onDec} className={btn} aria-label="−" type="button">
        −
      </button>
      <span className={cn("text-center font-semibold tabular-nums", size === "sm" ? "w-6 text-xs" : "w-8 text-sm")}>
        {quantity}
      </span>
      <button onClick={onInc} className={btn} aria-label="+" type="button">
        +
      </button>
    </div>
  );
}

/* ─── Cart quantity control (whole units → stepper, loose goods → label + edit) ─── */

function CartQtyControl({
  item,
  editLabel,
  onEdit,
  onDec,
  onInc,
  size = "md",
}: {
  item: CartItem;
  editLabel: string;
  onEdit: () => void;
  onDec: () => void;
  onInc: () => void;
  size?: "sm" | "md";
}) {
  // Loose goods (kg/g/L/ml/m or fractional) can't use ±1 steppers —
  // show the formatted amount and an edit button that re-opens the unit dialog.
  const loose = !isWholeUnitProduct({ unit: item.unit || "pcs", allowFractional: item.allowFractional });
  if (!loose) {
    return <QtyStepper quantity={item.quantity} onDec={onDec} onInc={onInc} size={size} />;
  }

  const parts = smartQtyParts(item.quantity, item.unit, item.unitConversions);
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div className={cn("flex flex-col items-end leading-none", size === "sm" ? "text-sm" : "text-[15px]")}>
        <span className="font-bold tabular-nums text-neu-primary">{parts.primary}</span>
        {parts.alt && (
          <span className="text-[10px] font-medium text-neu-faint">{parts.alt}</span>
        )}
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label={editLabel}
        title={editLabel}
        className="flex h-6 w-6 items-center justify-center rounded-md border border-neu-hairline text-neu-faint transition-colors hover:bg-neu-sunken hover:text-neu-accent-ink"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
        </svg>
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   UNIT-QUANTITY DIALOG
   The "units magic": how much of a product are we selling?
   - By quantity: enter a number + unit (kg/g/L/ml...), converted to base units
   - By amount (sell-by-value): customer says "Rs 50 worth" → weight computed
   ═══════════════════════════════════════════════════════════════ */

function UnitQuantityDialog({
  product,
  maxQty,
  initialQty,
  editing,
  onConfirm,
  onClose,
  fx,
  displayCode,
}: {
  product: POSProduct;
  maxQty?: number;
  initialQty?: number;
  editing?: boolean;
  onConfirm: (baseQty: number) => void;
  onClose: () => void;
  fx: Record<string, number> | null;
  displayCode: string;
}) {
  const { t } = useI18n();
  const baseUnit = product.unit || "pcs";
  const saleUnits = getSaleUnits(baseUnit, product.unitConversions);
  const canAmount = Boolean(product.sellByValue);
  const wholeUnit = isWholeUnitProduct(product);

  const [mode, setMode] = React.useState<"qty" | "amount">(canAmount ? "amount" : "qty");
  const [qtyStr, setQtyStr] = React.useState(initialQty ? String(trimNumber(initialQty)) : "1");
  const [selUnit, setSelUnit] = React.useState(baseUnit);
  const [amountStr, setAmountStr] = React.useState("");

  const qtyVal = parseFloat(qtyStr);
  const amountVal = parseFloat(amountStr);
  // The typed amount is in the currency the cashier SEES — convert it to
  // base cents (exact identity when no display conversion is active).
  const cents = Number.isFinite(amountVal) && amountVal > 0 ? displayMajorToBaseCents(amountVal, fx) : 0;
  const rawQty =
    mode === "amount"
      ? quantityForValue(cents, product.unitPrice)
      : Number.isFinite(qtyVal) && qtyVal > 0
        ? toBaseQty(qtyVal, selUnit, baseUnit, product.unitConversions)
        : 0;
  const cap = typeof maxQty === "number" ? maxQty : Infinity;
  const baseQty = rawQty > 0 ? Math.min(rawQty, Math.max(0, cap)) : 0;
  const limited = Number.isFinite(cap) && rawQty > cap;
  const parts = smartQtyParts(baseQty, baseUnit, product.unitConversions);
  const valid = baseQty > 0;
  const lineTotal = Math.round(baseQty * product.unitPrice);
  // Chips are seeded in BASE major units (Rs 10/20/…), typed into the
  // input as their display-currency equivalent so "chip = Rs 10 of goods"
  // holds in every display currency.
  const amountChips = [10, 20, 50, 100, 200];

  const metric = baseUnit === "g" || baseUnit === "kg" || baseUnit === "L" || baseUnit === "ml" || baseUnit === "m";
  const canQtyMode = Boolean(product.allowFractional) || metric || wholeUnit;

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("pos.quantity")}</DialogTitle>
        </DialogHeader>
        {/* Two-zone layout: inputs left, sticky live result right (md+) */}
          <DialogBody className="grid gap-4 md:grid-cols-[1fr_10rem]">
            <div className="space-y-4">
              {/* Product summary */}
              <div className="flex items-center gap-3 rounded-lg border border-neu-hairline bg-neu-sunken p-3">
                <ProductThumb src={product.imageUrl} name={product.name} className="h-11 w-11 rounded-lg" iconClassName="h-5 w-5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-neu-primary">{product.name}</p>
                  <p className="text-xs tabular-nums text-neu-faint">
                    {formatCurrency(product.unitPrice)}
                    {perUnitSuffix(product.unit) && <span className="text-neu-faint">{perUnitSuffix(product.unit)}</span>}
                  </p>
                </div>
                {typeof maxQty === "number" && (
                  <span className="shrink-0 rounded-full bg-neu-bg px-2 py-1 text-[10px] font-medium tabular-nums text-neu-faint shadow-sm">
                    {t("pos.available")}: {stockQtyText(maxQty, product.unit)}
                  </span>
                )}
              </div>

              {/* Mode switch: amount-of-money ⇄ quantity (when both make sense) */}
              {canAmount && canQtyMode && (
                <div className="pos-segmented w-full" role="group" aria-label={t("pos.quantity")}>
                  <button
                    type="button"
                    aria-pressed={mode === "amount"}
                    onClick={() => setMode("amount")}
                    className={cn("pos-segmented-btn", mode === "amount" && "active")}
                  >
                    {t("pos.byAmount")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "qty"}
                    onClick={() => setMode("qty")}
                    className={cn("pos-segmented-btn", mode === "qty" && "active")}
                  >
                    {t("pos.byQuantity")}
                  </button>
                </div>
              )}

              {/* ── By amount: "Rs 50 worth of sugar" ── */}
              {mode === "amount" ? (
                <div className="space-y-3">
                  <Input
                    label={t("pos.customerPays")}
                    type="number"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    hint={isDisplayConverted(fx) ? t("currency.typedIn", { code: displayCode }) : undefined}
                  />
                  <div className="flex flex-wrap gap-2">
                    {amountChips.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setAmountStr(baseCentsToDisplayMajorStr(c * 100, fx))}
                        className="pos-cash-quick-btn w-auto min-w-16 flex-none border border-neu-hairline bg-neu-bg px-3 tabular-nums text-neu-muted hover:bg-neu-sunken"
                      >
                        {/* Chip label = same VALUE the click types in (display
                            currency), never a converted label over an unconverted
                            typed value. The typed display-major is converted to
                            base cents by the shared reverse-path helper. */}
                        {/* Chip label = same VALUE the click types in (display
                            currency), never a converted label over an unconverted
                            typed value. */}
                        {baseCentsToDisplayMajorStr(c * 100, fx)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* ── By quantity: number + unit selector ── */
                <div className="space-y-3">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        label={t("pos.quantity")}
                        type="number"
                        value={qtyStr}
                        onChange={(e) => setQtyStr(e.target.value)}
                        placeholder={wholeUnit ? "1" : "0.00"}
                        min="0"
                        step={wholeUnit ? "1" : "any"}
                      />
                    </div>
                    <div className="w-28 shrink-0">
                      <Label>{t("pos.chooseUnit")}</Label>
                      <select
                        value={selUnit}
                        onChange={(e) => setSelUnit(e.target.value)}
                        className="mt-1.5 flex h-9 w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary neu-focus"
                      >
                        {saleUnits.map((u) => (
                          <option key={u.unit} value={u.unit}>
                            {u.unit}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {limited && (
                <p className="rounded-lg bg-neu-wash-amber px-3 py-2 text-xs font-medium text-neu-ink-amber">
                  {t("pos.stockLimited")} · {t("pos.available")}: {stockQtyText(maxQty!, product.unit)}
                </p>
              )}
            </div>

            {/* Right zone: live computed result (sidebar on md+, banner on mobile) */}
            <div className="self-start rounded-xl bg-neu-accent-wash p-4 text-center ring-1 ring-inset ring-neu-accent-line md:sticky md:top-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-neu-faint">
                {mode === "amount" ? t("pos.youGet") : t("pos.lineTotal")}
              </p>
              {valid ? (
                <>
                  <p className="mt-1.5 text-xl font-bold tabular-nums leading-tight text-neu-primary">
                    {parts.primary}
                  </p>
                  {parts.alt && (
                    <p className="text-[11px] font-medium text-neu-faint">≈ {parts.alt}</p>
                  )}
                  <div className="my-2 border-t border-dashed border-neu-accent-line" />
                  <p className="pos-money text-base font-extrabold text-neu-accent-ink">
                    {formatCurrency(lineTotal)}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-neu-faint">—</p>
              )}
            </div>
          </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!valid} onClick={() => valid && onConfirm(baseQty)}>
            {editing ? t("pos.updateQty") : t("pos.addToOrder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PRODUCT DETAILS DIALOG
   Full product card for the register: name, stock, cost & sale
   price, margin, category, unit & selling mode + add action.
   ═══════════════════════════════════════════════════════════════ */

function ProductDetailDialog({
  product,
  onClose,
  onAdd,
  onAddVariant,
}: {
  product: POSProduct;
  onClose: () => void;
  onAdd: (product: POSProduct) => void;
  onAddVariant: (product: POSProduct, variant: POSVariant) => void;
}) {
  const { t } = useI18n();
  // Use warehouse-specific stock when warehouse is selected, otherwise total
  const effectiveAvailable = product.warehouseId ? product.available : product.totalAvailable;
  const out = effectiveAvailable <= 0;
  const low = !out && effectiveAvailable <= 5;
  const baseUnit = product.unit || "pcs";
  const marginPct =
    product.unitPrice > 0 ? ((product.unitPrice - product.costPrice) / product.unitPrice) * 100 : 0;
  const marginTone =
    marginPct >= 25
      ? "text-neu-ink-green"
      : marginPct >= 10
        ? "text-neu-accent-ink"
        : marginPct >= 0
          ? "text-neu-ink-amber"
          : "text-neu-ink-red";

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("pos.productDetails")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Product identity */}
          <div className="flex items-start gap-4">
            <ProductThumb src={product.imageUrl} name={product.name} className="h-16 w-16 rounded-xl ring-1 ring-inset ring-neu-hairline/60" iconClassName="h-7 w-7" />
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold tracking-tight text-neu-primary">{product.name}</h3>
              <p className="mt-0.5 truncate font-mono text-xs text-neu-faint">
                {product.sku}
                {product.barcode ? ` · ${product.barcode}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full border border-neu-hairline px-2 py-0.5 text-[10px] font-semibold text-neu-muted">
                  {t("pos.soldBy")}: {baseUnit}
                </span>
                {product.sellByValue && (
                  <span className="rounded-full bg-neu-accent-wash px-2 py-0.5 text-[10px] font-semibold text-neu-accent-ink-strong">
                    {t("products.form.sellByValue")}
                  </span>
                )}
                {product.allowFractional && (
                  <span className="rounded-full bg-neu-wash-cyan px-2 py-0.5 text-[10px] font-semibold text-neu-ink-cyan">
                    {t("products.form.allowFractional")}
                  </span>
                )}
                {product.categoryName && (
                  <span className="rounded-full bg-neu-sunken px-2 py-0.5 text-[10px] font-medium text-neu-muted">
                    {product.categoryName}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Two-column layout: identity & description | financial & stock
              (collapses to one column on narrow screens) */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Left column: category meta + description */}
            <div className="flex flex-col gap-3">
              <div className="space-y-2 rounded-xl border border-neu-hairline p-3 text-xs">
                <div className="flex justify-between text-neu-faint">
                  <span>{t("products.category")}</span>
                  <span className="font-medium text-neu-primary">{product.categoryName || "—"}</span>
                </div>
                {product.taxRate > 0 && (
                  <div className="flex justify-between text-neu-faint">
                    <span>{t("products.tax")}</span>
                    <span className="font-medium tabular-nums text-neu-primary">{product.taxRate}%</span>
                  </div>
                )}
                <div className="flex justify-between text-neu-faint">
                  <span>{t("pos.soldBy")}</span>
                  <span className="font-medium text-neu-primary">{baseUnit}</span>
                </div>
              </div>
              {product.description && (
                <div className="flex-1 rounded-xl border border-neu-hairline p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">{t("products.description")}</p>
                  <p className="mt-1 line-clamp-5 text-sm leading-relaxed text-neu-muted">{product.description}</p>
                </div>
              )}
            </div>

            {/* Right column: financial snapshot + stock */}
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-neu-hairline bg-neu-bg p-3 text-center">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">{t("products.price")}</p>
                  <p className="pos-money mt-1 text-sm font-bold text-neu-primary">
                    {formatCurrency(product.unitPrice)}
                    {perUnitSuffix(product.unit) && <span className="text-[10px] font-medium text-neu-faint">{perUnitSuffix(product.unit)}</span>}
                  </p>
                </div>
                <div className="rounded-xl border border-neu-hairline bg-neu-bg p-3 text-center">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">{t("products.cost")}</p>
                  <p className="pos-money mt-1 text-sm font-bold text-neu-primary">{formatCurrency(product.costPrice)}</p>
                </div>
                <div className="rounded-xl border border-neu-hairline bg-neu-bg p-3 text-center">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">{t("pos.margin")}</p>
                  <p className={cn("mt-1 text-sm font-bold tabular-nums", marginTone)}>
                    {product.unitPrice > 0 ? `${Math.round(marginPct)}%` : "—"}
                  </p>
                </div>
              </div>
              <div className="flex-1 rounded-xl border border-neu-hairline p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">{t("pos.stockColumn")}</p>
                <p
                  className={cn(
                    "mt-1 text-lg font-bold tabular-nums",
                    out
                      ? "text-neu-ink-red"
                      : low
                        ? "text-neu-ink-amber"
                        : "text-neu-primary"
                  )}
                >
                  {stockQtyText(effectiveAvailable, product.unit)}
                </p>
                <p className="mt-0.5 text-[11px] text-neu-faint">
                  {out ? t("pos.outOfStock") : low ? t("pos.low") : `${t("pos.available")} · ${t("pos.inStock")}`}
                </p>
              </div>
            </div>
          </div>

          {/* Variant picker — each active variant is its own sellable line
              with its own price/stock; tapping one adds THAT variant. */}
          {product.variants.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neu-faint">
                {t("pos.variants")} · {product.variants.length}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {product.variants.map((v) => {
                  const vAvailable = product.warehouseId ? v.available : v.totalAvailable;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      disabled={vAvailable <= 0}
                      onClick={() => {
                        onClose();
                        onAddVariant(product, v);
                      }}
                      className={cn(
                        "group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-start transition-colors",
                        vAvailable <= 0
                          ? "cursor-not-allowed border-neu-hairline opacity-50"
                          : "border-neu-hairline hover:border-neu-accent-line hover:bg-neu-accent-wash"
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block max-w-[140px] truncate text-xs font-semibold text-neu-primary">
                          {v.name}
                        </span>
                        <span className="block font-mono text-[10px] text-neu-faint">
                          {v.sku}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-bold tabular-nums text-neu-accent-ink">
                        {formatCurrency(v.unitPrice)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                          vAvailable <= 0
                            ? "bg-neu-wash-red text-neu-ink-red"
                            : vAvailable <= 5
                              ? "bg-neu-wash-amber text-neu-ink-amber"
                              : "bg-neu-wash-green text-neu-ink-green"
                        )}
                      >
                        {Math.floor(vAvailable)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </DialogBody>

        {/* Actions */}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button disabled={out} onClick={() => onAdd(product)}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t("pos.addItem")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════ */

export default function POSPage() {
  // Re-render (and re-format amounts) when the store currency syncs or changes.
  const baseCurrencyCode = useStoreCurrency();
  const cart = useCartStore();
  const { t } = useI18n();
  // The code the cashier is typing in (display currency when converted,
  // otherwise the store base) — shown on money-input hints.
  const displayCurrencyCode = getDisplayCurrency() ?? baseCurrencyCode;
  const paymentMethods = ["cash", "credit_card", "debit_card", "digital_wallet"] as const;

  // Search state
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<POSProduct[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState(false);
  const [searchReloadKey, setSearchReloadKey] = React.useState(0);
  const [activeSearchIndex, setActiveSearchIndex] = React.useState(-1);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  // The mobile cart sheet is the one overlay on this page built by hand
  // instead of on <Dialog>, so it owns its own keyboard contract; otherwise it
  // would announce "aria-modal" and then let Tab walk behind the scrim.
  const mobileCartRef = React.useRef<HTMLDivElement>(null);

  // Payment state
  const [paymentOpen, setPaymentOpen] = React.useState(false);
  const [paymentMethod, setPaymentMethod] = React.useState("cash");
  const [amountPaid, setAmountPaid] = React.useState("");
  const [processing, setProcessing] = React.useState(false);

  // Receipt state
  const [receiptOpen, setReceiptOpen] = React.useState(false);
  const [completedOrder, setCompletedOrder] = React.useState<CompletedOrder | null>(null);
  const { data: session } = useSession();

  // Discount state
  const [discountModalOpen, setDiscountModalOpen] = React.useState(false);
  const [discountTargetId, setDiscountTargetId] = React.useState<string | null>(null);
  const [discountType, setDiscountType] = React.useState<"percentage" | "fixed">("percentage");
  const [discountValue, setDiscountValue] = React.useState("");

  // Live FX rates for the reverse (typed → base) conversion path. One
  // fetch per mount; the provider usually warms this cache already.
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

  // Customer state — the picker drives both the cart store (id + name,
  // persisted with the cart) and the local record (phone/points for display).
  const [pickedCustomer, setPickedCustomer] = React.useState<PickedCustomer | null>(null);

  // Loyalty redemption — points to burn on this sale (1 point = 1 cent).
  const [loyaltyRedeem, setLoyaltyRedeem] = React.useState(0);

  // Mobile cart drawer
  const [mobileCartOpen, setMobileCartOpen] = React.useState(false);
  useModalFocus(mobileCartOpen, mobileCartRef);

  // Restore a persisted cart customer after a refresh: the store keeps
  // id+name, so re-fetch the full record for phone/loyalty display.
  React.useEffect(() => {
    const persistedId = cart.customerId;
    if (!persistedId || pickedCustomer) return;
    let cancelled = false;
    fetch(`/api/customers/${persistedId}`)
      .then((r) => r.json())
      .then((d) => {
        const c = d.customer;
        if (!cancelled && c?.id) {
          setPickedCustomer({
            id: c.id,
            name: c.name,
            phone: c.phone,
            email: c.email,
            loyaltyPoints: c.loyaltyPoints,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browse products: cards (grid) or detailed table
  const [viewMode, setViewMode] = React.useState<"grid" | "table">("grid");

  // ── Low-stock restock strip ─────────────────────────────────────
  // Rows from the shared lookup endpoint whose stockStatus is low/out
  // for the selected warehouse; a one-tap "+10" top-up via the
  // restock API (permission-gated server-side).
  const [restockOpen, setRestockOpen] = React.useState(false);
  const [restockItems, setRestockItems] = React.useState<POSProduct[]>([]);
  const [restockLoading, setRestockLoading] = React.useState(false);
  const [restockingId, setRestockingId] = React.useState<string | null>(null);
  const canRestock = (session?.user as { permissions?: string[] } | undefined)?.permissions?.includes("inventory:adjust") ?? false;

  // Unit-aware quantity dialog (weight / "Rs X worth" sales)
  const [qtyDialog, setQtyDialog] = React.useState<{
    product: POSProduct;
    variantId?: string | null; // Pinned variant for the new line (scanned variant barcode)
    editItemId?: string | null; // When set, we update an existing cart line instead of adding
    maxQty?: number; // Stock available to clamp against (base units)
    initialQty?: number; // Existing quantity when editing a cart line
  } | null>(null);

  // Product quick-details dialog
  const [detailProduct, setDetailProduct] = React.useState<POSProduct | null>(null);

  // Camera barcode scanner
  const [scannerOpen, setScannerOpen] = React.useState(false);

  // ─── SCAN → AUTO-ADD PIPELINE ────────────────────────────────
  // Every scan source (camera scanner dialog, USB/Bluetooth hardware
  // wedge, manual typing) funnels through resolveScan(): the scanned
  // value is expanded into GTIN-family lookup candidates, resolved
  // against /api/pos/search, and the best match is auto-added to the
  // cart. Zero-click scanning — the cashier never touches the
  // keyboard. Weight/amount products still open their quantity
  // dialog; ambiguous matches open the search results to pick from.
  const [scanNotFound, setScanNotFound] = React.useState<string | null>(null);
  const resolveScanBusyRef = React.useRef(false);

  const resolveScan = React.useCallback(
    async (rawValue: string) => {
      const code = parseScan(rawValue)[0] ?? rawValue.trim();
      if (!code || resolveScanBusyRef.current) return;
      resolveScanBusyRef.current = true;
      try {
        setScanNotFound(null);
        const whId = useWarehouseStore.getState().selectedWarehouseId ?? "";
        // Try every GTIN candidate (UPC-A ↔ EAN-13 ↔ GTIN-14) before
        // giving up — the product may be saved in a different form than
        // the scanner emits.
        let products: POSProduct[] = [];
        for (const candidate of barcodeCandidates(code)) {
          const res = await fetch(
            `/api/pos/search?q=${encodeURIComponent(candidate)}&warehouseId=${whId}`
          );
          if (!res.ok) continue;
          const data = await res.json();
          products = (data.products ?? []).map(mapPosProduct);
          // Exact barcode hit — stop immediately.
          if (products.some((p) => p.barcode === candidate)) break;
          // Name/SKU matches also work, but a second candidate may do
          // better — only keep going while we have nothing at all.
          if (products.length > 0) break;
        }

        if (products.length === 0) {
          setScanNotFound(code);
          toast.error(t("pos.scanNotFound"), code);
          return;
        }

        // Exact barcode match wins even inside candidate mode — on the
        // product itself OR on any of its variants (scanned a "Family
        // Pack" GTIN → the variant line goes in the cart, not the base).
        const cands = barcodeCandidates(code);
        let exact: POSProduct | undefined;
        let exactVariant: POSVariant | undefined;
        for (const p of products) {
          if (p.barcode && cands.includes(p.barcode)) { exact = p; break; }
          const hit = p.variants.find((v) => v.barcode && cands.includes(v.barcode));
          if (hit) { exact = p; exactVariant = hit; break; }
        }
        const best = exact ?? products[0]!;

        if (products.length === 1 || exact) {
          // Ambiguous SKU/name matches only auto-add when unambiguous.
          const available = exactVariant
            ? (best.warehouseId ? exactVariant.available : exactVariant.totalAvailable)
            : (best.warehouseId ? best.available : best.totalAvailable);
          if (available <= 0) {
            setScanNotFound(null);
            toast.warning(t("pos.outOfStock"), exactVariant ? `${best.name} — ${exactVariant.name}` : best.name);
            return;
          }
          handleAddProduct(best, exactVariant);
          toast.success(
            t("pos.scanAdded", { name: exactVariant ? `${best.name} — ${exactVariant.name}` : best.name })
          );
        } else {
          // Multiple non-exact matches — surface them in search results.
          setSearchQuery(code);
          setSearchResults(products);
          toast.warning(t("pos.scanAmbiguous", { code, count: products.length }));
        }
      } catch {
        toast.error(t("pos.scanLookupFailed"), code);
      } finally {
        resolveScanBusyRef.current = false;
      }
    },
    [t]
  );

  // ─── HARDWARE SCANNER WEDGE ──────────────────────────────────
  // USB/Bluetooth 1D scanners emulate a keyboard: they type the code
  // in a burst and finish with Enter. The shared hook captures that
  // burst globally (capture-phase Enter interception beats the search
  // input's own handler, so scans can't double-add). Scans resolve
  // through the same auto-add pipeline as the camera scanner.
  useHardwareScanner({ onScan: resolveScan });

  // Cashier drawer
  const [cashierOpen, setCashierOpen] = React.useState(false);
  const [cashFloat, setCashFloat] = React.useState(0);
  const [shiftNote, setShiftNote] = React.useState("");

  // Bump to force the browse-grid effect to re-fetch (warehouse switch,
  // post-checkout refresh, cross-tab stock sync, F5).
  const [gridRefreshKey, setGridRefreshKey] = React.useState(0);
  const refreshGrid = React.useCallback(() => setGridRefreshKey((k) => k + 1), []);

  // Cross-tab stock sync via BroadcastChannel
  useStockSync(
    // When another tab changes stock, refresh the product grid
    React.useCallback(() => {
      refreshGrid();
    }, [refreshGrid]),
    // When another tab requests a refresh
    React.useCallback(() => {
      refreshGrid();
    }, [refreshGrid])
  );

  // Newly-added cart item flash highlight
  const [flashItemId, setFlashItemId] = React.useState<string | null>(null);
  const flashTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the flash timer on unmount
  React.useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // Cash amount input (auto-focused when the payment modal opens)
  const amountInputRef = React.useRef<HTMLInputElement>(null);

  // Store receipt branding (from /api/settings)
  const [storeReceipt, setStoreReceipt] = React.useState({
    storeName: "",
    storeAddress: "",
    storePhone: "",
    receiptHeader: "",
    receiptFooter: "",
    receiptQrPayment: "",
  });

  // Subscribe to the selected warehouse so the browse grid re-fetches when
  // the header selector changes (stock chips must match the selling store).
  const warehouseId = useWarehouseStore((s) => s.selectedWarehouseId);
  const warehouseName = useWarehouseStore((s) => s.warehouses.find((w) => w.id === s.selectedWarehouseId)?.name ?? null);

  // Browse mode (product grid + category chips)
  const [categories, setCategories] = React.useState<Array<{ id: string; name: string }>>([]);
  const [activeCategory, setActiveCategory] = React.useState("");
  const [browseProducts, setBrowseProducts] = React.useState<POSProduct[]>([]);

  // Margin panel table sort (client-side over the loaded rows; the panel
  // never pages, so the whole dataset is in memory). The default name/asc
  // keeps the list stable while the cashier scans the margin spread.
  const [marginSort, setMarginSort] = React.useState("name.asc");
  const sortedBrowseProducts = React.useMemo(() => {
    const [field, order] = marginSort.split(".");
    const sign = order === "asc" ? 1 : -1;
    const rows = [...browseProducts];
    rows.sort((a, b) => {
      switch (field) {
        case "stock":
          return sign * ((a.available ?? 0) - (b.available ?? 0));
        case "cost":
          return sign * ((a.costPrice ?? 0) - (b.costPrice ?? 0));
        case "price":
          return sign * ((a.unitPrice ?? 0) - (b.unitPrice ?? 0));
        case "margin": {
          const ma =
            a.unitPrice > 0 ? (a.unitPrice - a.costPrice) / a.unitPrice : 0;
          const mb =
            b.unitPrice > 0 ? (b.unitPrice - b.costPrice) / b.unitPrice : 0;
          return sign * (ma - mb);
        }
        case "category":
          return (
            sign *
            (a.categoryName ?? "").localeCompare(b.categoryName ?? "")
          );
        default:
          return sign * (a.name ?? "").localeCompare(b.name ?? "");
      }
    });
    return rows;
  }, [browseProducts, marginSort]);
  function toggleMarginSort(field: string) {
    setMarginSort((s) => {
      if (s.startsWith(`${field}.`)) {
        return `${field}.${s.endsWith(".asc") ? "desc" : "asc"}`;
      }
      return `${field}.${field === "name" || field === "category" ? "asc" : "desc"}`;
    });
  }
  const [browseLoading, setBrowseLoading] = React.useState(true);
  const [browseError, setBrowseError] = React.useState(false);

  // Load categories for browse chips
  React.useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => {});
  }, []);

  // Load store settings used on the receipt header/footer
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
          receiptHeader: s.receiptHeader ?? "",
          receiptFooter: s.receiptFooter ?? "",
          receiptQrPayment: s.receiptQrPayment ?? "",
        });
      })
      .catch(() => {});
  }, []);

  // Low-stock restock strip: fetch low/out rows for the selected warehouse
  // from the shared lookup endpoint (same numbers as every other page).
  const refreshRestockStrip = React.useCallback(() => {
    const whId = useWarehouseStore.getState().selectedWarehouseId ?? "";
    setRestockLoading(true);
    const params = new URLSearchParams({ status: "low,out", limit: "20" });
    if (whId) params.set("warehouseId", whId);
    fetch(`/api/products/lookup?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setRestockItems((d.products ?? []).map(mapPosProduct));
      })
      .catch(() => setRestockItems([]))
      .finally(() => setRestockLoading(false));
  }, []);

  React.useEffect(() => {
    refreshRestockStrip();
  }, [refreshRestockStrip, warehouseId, gridRefreshKey]);

  async function quickRestock(product: POSProduct) {
    const whId = useWarehouseStore.getState().selectedWarehouseId ?? "";
    if (!whId) {
      toast.error(t("pos.errors.noWarehouse"), t("pos.errors.noWarehouseDesc"));
      return;
    }
    const step = Math.max(1, Math.ceil((product.minStockLevel ?? 10) / 2));
    setRestockingId(product.id);
    try {
      const res = await fetch("/api/inventory/restock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, warehouseId: whId, quantity: step }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("pos.restockFailed"), typeof data.error === "string" ? data.error : undefined);
        return;
      }
      toast.success(
        t("pos.restockDone"),
        `${product.name} · ${t("pos.restockQty")}: +${step} → ${trimNumber(data.newQuantity ?? 0)}`
      );
      broadcastStockChange(product.id, whId, data.newQuantity ?? 0);
      refreshRestockStrip();
      setGridRefreshKey((k) => k + 1);
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setRestockingId(null);
    }
  }

  // Load browse products (grid) whenever the category or warehouse changes
  React.useEffect(() => {
    let cancelled = false;
    setBrowseLoading(true);
    setBrowseError(false);
    const whId = useWarehouseStore.getState().selectedWarehouseId ?? "";
    const params = new URLSearchParams({ limit: "100" });
    if (activeCategory) params.set("categoryId", activeCategory);
    if (whId) params.set("warehouseId", whId);

    fetch(`/api/pos/search?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          // Shared mapper keeps browse results identical to search results
          const products: POSProduct[] = (d.products ?? []).map(mapPosProduct);
          setBrowseProducts(products);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBrowseProducts([]);
          setBrowseError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setBrowseLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Re-fetch when the warehouse selector changes so stock chips always
    // reflect the store the cashier is actually selling from.
  }, [activeCategory, warehouseId, gridRefreshKey]);

  // Focus the scanner field once, on mount. This deliberately does NOT live in
  // the shortcut effect below: that effect's dependencies are the dialog
  // states, so it re-runs every time a dialog opens or closes, and the focus()
  // would then fight the modal's own focus management — yanking focus out of a
  // panel that just opened, and stealing it from the trigger Radix restores on
  // close (leaving the cashier's keyboard focus somewhere they never chose).
  React.useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Register the keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts when typing in inputs/selects
      const tag = (e.target as HTMLElement).tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // F1 — show keyboard shortcuts help
      if (e.key === "F1") {
        e.preventDefault();
        toast.info(
          "Keyboard Shortcuts",
          "F2: New Sale · F3: Toggle View · F4/F8/F9: Payment · F5: Refresh · F6: Scan · F10: Complete · Esc: Close"
        );
        return;
      }

      // F2 — start a new sale (clear cart + focus scanner)
      if (e.key === "F2") {
        e.preventDefault();
        cart.clearCart();
        searchInputRef.current?.focus();
        return;
      }

      // F3 — toggle the product grid/table view
      if (e.key === "F3") {
        e.preventDefault();
        setViewMode((v) => (v === "grid" ? "table" : "grid"));
        return;
      }

      // F4 / F8 / F9 — charge the customer (open the payment dialog)
      if ((e.key === "F4" || e.key === "F8" || e.key === "F9") && cart.itemCount > 0 && !isInput) {
        e.preventDefault();
        setPaymentOpen(true);
        return;
      }

      // F5 — refresh the product grid
      if (e.key === "F5" && !isInput) {
        e.preventDefault();
        refreshGrid();
        return;
      }

      // F6 — open the camera scanner
      if (e.key === "F6") {
        e.preventDefault();
        setScannerOpen(true);
        return;
      }

      // F10 — new transaction (after receipt is shown)
      if (e.key === "F10" && receiptOpen) {
        e.preventDefault();
        newTransaction();
        return;
      }

      // Escape — close any open modal/dialog
      if (e.key === "Escape") {
        if (receiptOpen) { setReceiptOpen(false); return; }
        if (paymentOpen) { setPaymentOpen(false); return; }
        if (qtyDialog) { setQtyDialog(null); return; }
        if (detailProduct) { setDetailProduct(null); return; }
        if (discountModalOpen) { setDiscountModalOpen(false); return; }
        if (mobileCartOpen) { setMobileCartOpen(false); return; }
        return;
      }

      // Ctrl+Enter — process payment when in payment modal
      if (e.key === "Enter" && e.ctrlKey && paymentOpen) {
        e.preventDefault();
        processPayment();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // Handlers below are stable component closures; re-subscribing on every
    // re-render (refreshGrid changes each fetch) would churn listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, receiptOpen, paymentOpen, qtyDialog, detailProduct, discountModalOpen, mobileCartOpen]);

  // Search products (debounced)
  React.useEffect(() => {
    if (!searchQuery || searchQuery.length < 1) {
      setSearchResults([]);
      setActiveSearchIndex(-1);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(false);
      try {
        const whId = useWarehouseStore.getState().selectedWarehouseId ?? "";
        const res = await fetch(`/api/pos/search?q=${encodeURIComponent(searchQuery)}&warehouseId=${whId}`);
        const data = await res.json();
        // Shared mapper keeps search results identical to browse results
        const products: POSProduct[] = (data.products ?? []).map(mapPosProduct);
        setSearchResults(products);
        setActiveSearchIndex(-1);
      } catch {
        setSearchResults([]);
        setSearchError(true);
        setActiveSearchIndex(-1);
      } finally {
        setSearching(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [searchQuery, searchReloadKey]);

  // Keep the highlighted search result visible while arrow-navigating
  React.useEffect(() => {
    if (activeSearchIndex < 0) return;
    document
      .getElementById(`pos-result-${activeSearchIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchIndex]);

  // Clear the live search panel and re-focus the scanner input
  function resetSearch() {
    setSearchQuery("");
    setSearchResults([]);
    setActiveSearchIndex(-1);
    searchInputRef.current?.focus();
  }

  // Flash the freshly-added cart row so it is easy to spot
  function flashAdded(productId: string) {
    setFlashItemId(productId);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashItemId(null), 900);
  }

  // Add a product to the cart in its base units (whole-unit products pass 1).
  // `variant` selects a specific variant line — its price/SKU/stock ride
  // through the cart so checkout decrements the VARIANT stock row (matching
  // checkout-service) instead of silently draining base stock.
  function addToCart(product: POSProduct, quantity = 1, variant?: POSVariant) {
    const unit = product.unit || "pcs";
    const v = variant ?? (product as POSProduct & { variant?: POSVariant }).variant;
    // Use totalAvailable for consistency with /api/products, but respect warehouse-specific stock
    const stockAvailable = v
      ? (product.warehouseId ? v.available : v.totalAvailable)
      : product.warehouseId
        ? product.available
        : product.totalAvailable;
    cart.addItem({
      productId: product.id,
      variantId: v?.id,
      productName: v ? `${product.name} — ${v.name}` : product.name,
      sku: v?.sku ?? product.sku,
      imageUrl: (v as { imageUrl?: string | null } | undefined)?.imageUrl ?? product.imageUrl ?? undefined,
      quantity,
      unit,
      allowFractional: product.allowFractional,
      sellByValue: product.sellByValue,
      unitConversions: product.unitConversions ?? undefined,
      stockAvailable,
      unitPrice: v?.unitPrice ?? product.unitPrice,
      costPrice: v?.costPrice ?? product.costPrice,
      discountType: "percentage",
      discountValue: 0,
      taxRate: product.taxRate,
    });
    flashAdded(product.id);
    resetSearch();
  }

  // Weight/amount products need the unit-aware dialog before they can be sold
  function needsQtyDialog(product: POSProduct): boolean {
    return !isWholeUnitProduct(product);
  }

  // Smart entry point used by search results, cards and the detail dialog.
  // `variant` pins the cart line to a specific variant (scanned variant
  // barcode / picked from the variant list).
  function handleAddProduct(product: POSProduct, variant?: POSVariant) {
    if (variant) {
      if (variant.available <= 0 && variant.totalAvailable <= 0) return;
      if (!isWholeUnitProduct(product)) {
        setQtyDialog({ product, maxQty: variant.available || variant.totalAvailable, variantId: variant.id });
      } else {
        addToCart(product, 1, variant);
      }
      return;
    }
    // Use warehouse-specific available when warehouse is selected, otherwise totalAvailable
    const available = product.warehouseId ? product.available : product.totalAvailable;
    if (available <= 0) return;
    if (needsQtyDialog(product)) {
      setQtyDialog({ product, maxQty: available });
    } else {
      addToCart(product, 1);
    }
  }

  // Re-open the quantity dialog for an existing unit-aware cart line
  function openCartQtyEditor(item: CartItem) {
    setQtyDialog({
      product: {
        id: item.productId,
        name: item.productName,
        sku: item.sku,
        imageUrl: item.imageUrl ?? null,
        unitPrice: item.unitPrice,
        costPrice: item.costPrice,
        taxRate: item.taxRate,
        unit: item.unit || "pcs",
        allowFractional: item.allowFractional,
        sellByValue: item.sellByValue,
        unitConversions: item.unitConversions ?? null,
        // Use the stockAvailable snapshot from the cart item (already set
        // consistently with the Products page by the shared mapper).
        stock: item.stockAvailable ?? item.quantity,
        reserved: 0,
        available: item.stockAvailable ?? item.quantity,
        totalStock: item.stockAvailable ?? item.quantity,
        totalReserved: 0,
        totalAvailable: item.stockAvailable ?? item.quantity,
        // Cart-line editor is scoped to this line's snapshot; the pinned
        // variant (if any) is irrelevant here — the edit updates quantity
        // on the existing line via editItemId.
        variants: [],
      },
      editItemId: item.id,
      maxQty: item.stockAvailable ?? undefined,
      initialQty: item.quantity,
    });
  }

  // Commit the base-unit quantity chosen in the dialog (add or update line)
  function commitQuantity(baseQty: number) {
    const dialog = qtyDialog;
    if (!dialog || !(baseQty > 0)) return;
    if (dialog.editItemId) {
      cart.updateItemQuantity(dialog.editItemId, baseQty);
      flashAdded(dialog.product.id);
    } else {
      const variant = dialog.variantId
        ? dialog.product.variants.find((v) => v.id === dialog.variantId)
        : undefined;
      addToCart(dialog.product, baseQty, variant);
    }
    setQtyDialog(null);
  }

  // Keyboard navigation over search results (↑/↓/↵)
  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const idx = activeSearchIndex >= 0 ? activeSearchIndex : 0;
      const target = searchResults[idx];
      if (target) handleAddProduct(target);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (searchResults.length > 0) {
        setActiveSearchIndex((i) => (i + 1) % searchResults.length);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (searchResults.length > 0) {
        setActiveSearchIndex((i) => (i <= 0 ? searchResults.length - 1 : i - 1));
      }
    }
  }

  // Open discount modal
  function openDiscount(itemId: string) {
    setDiscountTargetId(itemId);
    setDiscountType("percentage");
    setDiscountValue("");
    setDiscountModalOpen(true);
  }

  // Apply discount
  function applyDiscount() {
    if (!discountTargetId) return;
    const value = parseFloat(discountValue) || 0;
    if (value > 0) {
      if (discountType === "fixed") {
        // The cashier types an amount in the currency they SEE. Convert it
        // to base cents so stored discounts stay in the base unit.
        cart.updateItemDiscount(discountTargetId, "fixed", displayMajorToBaseCents(value, fx));
      } else {
        cart.updateItemDiscount(discountTargetId, "percentage", value);
      }
    }
    setDiscountModalOpen(false);
    setDiscountTargetId(null);
  }

  // Quick cash amounts (in dollars — manual entry is dollar-based)
  const quickCashAmounts = [5, 10, 20, 50, 100];

  // Loyalty redemption: 1 point = 1 cent, capped by the customer's balance
  // and by the cart total. The server re-validates and re-caps everything.
  const loyaltyValueCents = Math.min(loyaltyRedeem, cart.total);
  const finalTotal = Math.max(0, cart.total - loyaltyValueCents);
  const loyaltyInputValue = loyaltyRedeem > 0 ? String(loyaltyRedeem) : "";

  // Amount paid is typed in the currency the cashier SEES (base, or the
  // converted display currency). displayMajorToBaseCents is the exact
  // identity while unconverted, and converts typed values back to base
  // cents when a display currency is active — so payment math, change
  // and khata records all stay in base cents.
  const amountPaidCents = displayMajorToBaseCents(parseFloat(amountPaid) || 0, fx);

  // ── Partial payment (khata/credit) resolution ────────────────────
  // One shared rule (lib/payment-math) drives the dialog UI, the
  // footer button and what the server stores:
  //  - no customer → the register must collect the full bill
  //  - customer attached → a shortfall becomes credit due (khata)
  const hasCustomer = Boolean(pickedCustomer);
  const paymentResolution = resolvePayment(finalTotal, amountPaidCents, hasCustomer);
  const changeDue = paymentResolution.changeDue;
  const dueAmount = paymentResolution.dueAmount;
  const isCreditSale = paymentResolution.isCreditSale;
  const canAcceptShortPayment = isPartialPaymentAllowed(hasCustomer);

  // Collecting the customer's PREVIOUS khata balance alongside the new
  // bill. Server clamps to what's actually owed; the UI clamps to the
  // over-tender (cash beyond the current bill) so the dialog stays honest.
  const priorBalance = Math.max(0, pickedCustomer?.outstandingBalance ?? 0);
  const [settleInput, setSettleInput] = React.useState("");
  const settleCents = displayMajorToBaseCents(parseFloat(settleInput) || 0, fx);
  const maxSettleCents = Math.max(0, Math.min(priorBalance, Math.max(0, amountPaidCents - finalTotal)));
  const settleEffective = Math.min(settleCents, maxSettleCents);
  React.useEffect(() => {
    // Reset the settle field whenever the customer or tender changes.
    setSettleInput("");
  }, [pickedCustomer?.id]);

  // Suggested next bill for quick round-up (smallest chip >= final total).
  // Chips are expressed in the currency the cashier sees; conversions in
  ///out of base are rounded independently (x100 and ÷100), so compare
  // with a 1-cent tolerance rather than exact equality.
  const chipTol = 1;
  const nextBill = quickCashAmounts.find((amt) => displayMajorToBaseCents(amt, fx) + chipTol >= finalTotal) ?? null;

  // Auto-focus the cash amount field when the payment modal opens
  React.useEffect(() => {
    if (paymentOpen && paymentMethod === "cash") {
      const id = setTimeout(() => amountInputRef.current?.focus(), 80);
      return () => clearTimeout(id);
    }
  }, [paymentOpen, paymentMethod]);

  // Process payment
  async function processPayment() {
    setProcessing(true);
    try {
      // Ensure a real warehouse is selected before checking out — the API
      // also resolves "default"/missing server-side, but never send the
      // placeholder from here.
      let whId = useWarehouseStore.getState().selectedWarehouseId;
      if (!whId) {
        try {
          const res = await fetch("/api/warehouses");
          const data = await res.json();
          const whs = data.warehouses ?? [];
          const def = whs.find((w: { isDefault: boolean }) => w.isDefault) ?? whs[0];
          whId = def?.id ?? "";
        } catch {
          whId = "";
        }
      }
      if (!whId) {
        toast.error(t("pos.errors.noWarehouse"), t("pos.errors.noWarehouseDesc"));
        setProcessing(false);
        return;
      }

      const res = await fetch("/api/pos/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouseId: whId,
          items: cart.items.map((item) => ({
            productId: item.productId,
            // Variant lines carry variantId — checkout-service resolves
            // the variant's price and decrements the VARIANT stock row.
            ...(item.variantId ? { variantId: item.variantId } : {}),
            productName: item.productName,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit ?? "pcs",
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            discountType: item.discountType,
            discountValue: item.discountValue,
            discountAmount: item.discountAmount,
            taxRate: item.taxRate,
            taxAmount: item.taxAmount,
            total: item.total,
          })),
          subtotal: cart.subtotal,
          taxAmount: cart.taxAmount,
          discountAmount: cart.discountAmount,
          // `total` stays the PRE-redemption total — the server applies the
          // loyalty value itself and never trusts the client's arithmetic.
          total: cart.total,
          customerId: pickedCustomer?.id ?? undefined,
          loyaltyPointsRedeemed: loyaltyRedeem,
          paymentMethod,
          // Credit sale: send exactly what was collected. Full payment:
          // send the bill (or the over-tender so change is computed server-side).
          amountPaid: isCreditSale ? amountPaidCents : amountPaidCents || finalTotal,
          changeDue: Math.max(0, changeDue),
          // Old khata dues collected in the same transaction (server clamps).
          settleOutstanding: settleEffective > 0 ? settleEffective : undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data?.code === "insufficient_stock") {
          // Localized oversell notice — show product, available & requested with units
          const line = cart.items.find((i) => i.productId === data.productId);
          const unit = line?.unit || "pcs";
          const fmtQty = (n: number) =>
            `${trimNumber(n)}${WHOLE_UNITS.has(unit) ? "" : ` ${unit}`}`;
          toast.error(
            t("pos.errors.insufficientStock"),
            `${data.productName ?? ""} — ${t("pos.errors.available")}: ${fmtQty(data.available ?? 0)} · ${t("pos.errors.requested")}: ${fmtQty(data.requested ?? 0)}`
          );
        } else {
          toast.error(t("pos.paymentFailed"), typeof data.error === "string" ? data.error : undefined);
          // A stale cart (server prices changed mid-sale) is recoverable:
          // refresh the grid + search results so the retry uses fresh data.
          if (data?.code === "item_validation") refreshGrid();
        }
        return;
      }

      // Notify other tabs that stock moved. The exact post-sale on-hand is
      // server-owned; receivers treat the event as a "refresh now" signal
      // and re-fetch, so the payload is a best-effort approximation.
      for (const item of cart.items) {
        broadcastStockChange(
          item.productId,
          whId,
          Math.max(0, (item.stockAvailable ?? 0) - item.quantity)
        );
      }
      // Refresh THIS tab's grid so stock chips reflect the sale immediately.
      refreshGrid();

      setCompletedOrder({
        ...data.order,
        // The server already clamped loyalty and recomputed change — its
        // number is authoritative, not the client's pre-loyalty math.
        changeDue: data.order?.changeAmount ?? Math.max(0, changeDue),
        dueAmount: data.order?.dueAmount ?? 0,
        paymentStatus: data.order?.paymentStatus ?? "paid",
        paymentMethod,
        customer: data.order?.customer ?? null,
      });
      setPaymentOpen(false);
      setReceiptOpen(true);
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setProcessing(false);
    }
  }

  // New transaction after receipt
  async function saveCashierSession() {
    if (!session?.user?.name) {
      toast.error(t("pos.notLoggedIn"), t("pos.loginToContinue"));
      return;
    }
    setCashierOpen(false);
    toast.success(t("pos.cashierSessionSaved"), `${t("pos.cashier")}: ${session?.user?.name}`);
  }

  function newTransaction() {
    cart.clearCart();
    setReceiptOpen(false);
    setCompletedOrder(null);
    setAmountPaid("");
    setPaymentMethod("cash");
    setPickedCustomer(null);
    setLoyaltyRedeem(0);
    searchInputRef.current?.focus();
  }

  const hasCart = cart.itemCount > 0;

  return (
    <div className="flex h-[calc(100dvh-64px)] -mx-4 -my-6 flex-col sm:-mx-6 lg:-mx-8 md:flex-row overflow-hidden">
      {/* ─── LEFT PANEL: Product Search & Grid ─── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-e border-neu-hairline bg-neu-bg">
        {/* Search Bar */}
        <div className="shrink-0 border-b border-neu-hairline px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neu-accent-solid text-white shadow-sm shadow-neu-accent-line/25">
                <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold leading-tight tracking-tight text-neu-primary">
                  {t("nav.pos")}
                </h1>
                <p className="truncate text-[11px] leading-tight text-neu-faint">
                  {t("pos.navigateHint")}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* Warehouse pill — shows the store being sold from */}
              <span className="hidden items-center gap-1.5 rounded-full border border-neu-hairline bg-neu-sunken px-2.5 py-1 text-[11px] font-medium text-neu-faint lg:inline-flex">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z" />
                </svg>
                {warehouseName || t("common.all")}
              </span>
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="pos-icon-btn h-9 w-9"
                title={t("pos.scanBarcode")}
                aria-label={t("pos.scanBarcode")}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75zM6.75 16.5h.75v.75h-.75v-.75zM16.5 6.75h.75v.75h-.75v-.75zM13.5 13.5h.75v.75h-.75v-.75zM13.5 19.5h.75v.75h-.75v-.75zM19.5 13.5h.75v.75h-.75v-.75zM19.5 19.5h.75v.75h-.75v-.75zM16.5 16.5h.75v.75h-.75v-.75z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setCashierOpen(true)}
                className="pos-icon-btn h-9 w-9"
                title={t("pos.cashier")}
                aria-label={t("pos.cashier")}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </button>
            </div>
          </div>
          {/* Search field — below the title row so it always gets full width */}
          <div className="relative mt-3 flex gap-2">
            <div className="relative flex-1">
              <Input
                ref={searchInputRef}
                placeholder={t("pos.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                leftIcon={
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                }
              />
              {searchQuery && searchResults.length > 0 && (
                <kbd className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 rounded border border-neu-hairline bg-neu-sunken px-1.5 py-0.5 text-[10px] font-medium text-neu-faint">
                  {t("pos.enterToAdd")}
                </kbd>
              )}
            </div>
          </div>
          {/* Scan feedback — unresolved scanned code (non-blocking), with a
              scan-to-create hand-off straight into the Products form */}
          {scanNotFound && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-neu-ink-red/30 bg-neu-wash-red px-3 py-1.5 text-xs font-medium text-neu-ink-red">
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span className="min-w-0 flex-1 truncate">{t("pos.scanNotFound", { code: scanNotFound })}</span>
              <a
                href={`/products?createWithBarcode=${encodeURIComponent(scanNotFound)}`}
                className="shrink-0 rounded-md bg-neu-solid-red px-2 py-1 text-[11px] font-semibold text-white shadow-sm transition-colors"
              >
                {t("pos.scanCreateProduct")}
              </a>
              <button
                type="button"
                onClick={() => setScanNotFound(null)}
                className="shrink-0 rounded p-0.5 hover:bg-neu-wash-red"
                aria-label={t("common.close")}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Search Results (when searching) */}
        {searchQuery && (
          <div className="shrink-0 border-b border-neu-hairline bg-neu-sunken max-h-[38dvh] overflow-y-auto overscroll-contain pos-scroll">
            {searching ? (
              <div className="p-6 text-center">
                <Spinner size="lg" className="mx-auto mb-3 text-neu-accent-line" />
                <p className="text-xs font-medium text-neu-faint">{t("common.loading")}</p>
              </div>
            ) : searchError ? (
              <EmptyState
                bare
                error
                height="auto"
                className="py-6"
                icon={
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                }
                title={t("common.loadFailed")}
                description={t("common.loadFailedDesc")}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setSearchReloadKey((k) => k + 1)}>
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : searchResults.length === 0 ? (
              <EmptyState
                bare
                height="auto"
                className="py-6"
                icon={
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                }
                title={`${t("pos.noProductsFor")} "${searchQuery}"`}
                description={t("pos.noProductsInCategoryHint")}
              />
            ) : (
              <>
                <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
                  <p className="pos-caption-sm text-neu-faint">
                    {searchResults.length} {t("common.results")}
                  </p>
                  {activeSearchIndex >= 0 && (
                    <p className="text-xs font-semibold tabular-nums text-neu-accent-ink">
                      {activeSearchIndex + 1} / {searchResults.length}
                    </p>
                  )}
                </div>
                <div className="divide-y divide-neu-hairline pb-1">
                  {searchResults.map((product, index) => {
                    const out = product.available <= 0;
                    return (
                      <button
                        key={product.id}
                        id={`pos-result-${index}`}
                        onClick={() => handleAddProduct(product)}
                        onMouseEnter={() => setActiveSearchIndex(index)}
                        className={cn(
                          "flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors focus-visible:bg-neu-accent-wash neu-focus",
                          index === activeSearchIndex
                            ? "bg-neu-accent-wash ring-1 ring-inset ring-neu-accent-line"
                            : "hover:bg-neu-accent-wash/60",
                          out && "opacity-60"
                        )}
                      >
                        <ProductThumb src={product.imageUrl} name={product.name} className="h-10 w-10 rounded-lg flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-neu-primary">{product.name}</p>
                          <p className="pos-caption-xs-mono mt-0.5 text-neu-faint">{product.sku}</p>
                        </div>
                        <div className="shrink-0 text-end">
                          <p className="text-sm font-semibold text-neu-accent-ink tabular-nums">
                            {formatCurrency(product.unitPrice)}
                            {perUnitSuffix(product.unit) && (
                              <span className="text-[10px] font-medium text-neu-faint">{perUnitSuffix(product.unit)}</span>
                            )}
                          </p>
                          <p className={cn("mt-0.5 text-xs tabular-nums", out ? "text-neu-ink-red" : "text-neu-faint")}>
                            {product.available > 0
                              ? <><span className="pos-stock-badge pos-stock-badge-ok">{stockQtyText(product.available, product.unit)}</span> {t("pos.inStock")}</>
                              : t("pos.outOfStock")}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Category chips */}
        {!searchQuery && (
          <div className="pos-chip-row shrink-0 flex items-center gap-2 overflow-x-auto border-b border-neu-hairline px-4 py-2.5">
            <button
              onClick={() => setActiveCategory("")}
              aria-pressed={activeCategory === ""}
              className={cn("pos-chip", activeCategory === "" && "pos-chip-active")}
            >
              {t("common.all")}
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                aria-pressed={activeCategory === cat.id}
                className={cn("pos-chip", activeCategory === cat.id && "pos-chip-active")}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {/* Product grid */}
        {!searchQuery && (
          <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4">
            {/* Count + active category */}
            {!browseLoading && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="pos-caption-sm text-neu-faint">
                  {browseProducts.length} {t("pos.products")}
                  {activeCategory
                    ? ` · ${categories.find((c) => c.id === activeCategory)?.name ?? ""}`
                    : ""}
                </p>
                <div className="flex items-center gap-2">
                  {activeCategory && (
                    <button
                      onClick={() => setActiveCategory("")}
                      className="text-xs font-medium text-neu-accent-ink transition-colors hover:text-neu-accent-ink-strong"
                    >
                      {t("pos.clearCategory")}
                    </button>
                  )}
                  {/* View toggle: product cards ⇄ detailed table — segmented control */}
                  <div className="pos-segmented" role="group" aria-label={t("pos.viewLabel")}>
                    <button
                      type="button"
                      aria-pressed={viewMode === "grid"}
                      onClick={() => setViewMode("grid")}
                      className={cn("pos-segmented-btn", viewMode === "grid" && "active")}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                      </svg>
                      <span className="hidden lg:inline">{t("pos.viewGrid")}</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={viewMode === "table"}
                      onClick={() => setViewMode("table")}
                      className={cn("pos-segmented-btn", viewMode === "table" && "active")}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                      </svg>
                      <span className="hidden lg:inline">{t("pos.viewTable")}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
            {/* ── Low-stock restock strip ─────────────────────────── */}
            {!restockLoading && restockItems.length > 0 && canRestock && (
              <div
                className={cn(
                  "mb-3 flex items-center gap-2 overflow-x-auto pos-chip-row rounded-xl border px-3 py-2 shadow-xs",
                  restockItems.some((p) => p.stockStatus === "out")
                    ? "border-neu-ink-red/35 bg-neu-wash-red"
                    : "border-neu-ink-amber/35 bg-neu-wash-amber"
                )}
              >
                <button
                  type="button"
                  onClick={() => setRestockOpen((o) => !o)}
                  className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-neu-primary"
                  aria-expanded={restockOpen}
                >
                  <svg
                    className={cn("h-3.5 w-3.5 transition-transform", restockOpen && "rotate-90")}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  {t("pos.restockStripTitle")}
                  <span className="rounded-full bg-neu-scrim/10 px-1.5 py-0.5 text-[10px] tabular-nums">
                    {restockItems.length}
                  </span>
                </button>
                {restockOpen && (
                  <div className="flex min-w-max items-center gap-2 ps-2">
                    {restockItems.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center gap-2 rounded-lg border border-neu-hairline bg-neu-bg px-2.5 py-1.5"
                      >
                        <div className="min-w-0">
                          <p className="max-w-[140px] truncate text-xs font-medium text-neu-primary">
                            {p.name}
                          </p>
                          <p
                            className={cn(
                              "text-[10px] tabular-nums",
                              p.stockStatus === "out" ? "text-neu-ink-red" : "text-neu-ink-amber"
                            )}
                          >
                            {t("pos.stockLeft")}: {stockQtyText(p.available, p.unit)}
                            {p.stockStatus === "out" ? ` · ${t("products.outOfStock")}` : ""}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={restockingId === p.id}
                          disabled={restockingId !== null && restockingId !== p.id}
                          onClick={() => quickRestock(p)}
                          className="shrink-0"
                        >
                          {t("pos.restockBtn")}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {browseLoading ? (
              <div className="pos-grid">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="rounded-xl border border-neu-hairline bg-neu-bg p-3">
                    <div className="skeleton h-20 w-full rounded-none" />
                    <div className="mt-3 space-y-2">
                      <div className="skeleton h-3.5 w-4/5 rounded" />
                      <div className="skeleton h-3 w-2/5 rounded" />
                      <div className="mt-2 flex items-center justify-between">
                        <div className="skeleton h-4 w-16 rounded" />
                        <div className="skeleton h-3 w-14 rounded" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : browseError ? (
              <EmptyState
                bare
                error
                className="h-full"
                icon={
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                }
                title={t("common.loadFailed")}
                description={t("common.loadFailedDesc")}
                action={
                  <Button variant="secondary" size="sm" onClick={refreshGrid}>
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : browseProducts.length === 0 ? (
              <EmptyState
                bare
                className="h-full"
                icon={
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                }
                title={t("pos.noProductsInCategory")}
                description={t("pos.noProductsInCategoryHint")}
              />
            ) : viewMode === "table" ? (
              <div className="overflow-hidden rounded-xl border border-neu-hairline bg-neu-bg shadow-xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-neu-hairline bg-neu-sunken text-[11px] uppercase tracking-wider text-neu-faint">
                        <SortableTh label={t("products.name")} className="px-3 py-2.5" active={marginSort.startsWith("name.")} order={marginSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleMarginSort("name")} />
                        <SortableTh label={t("products.category")} className="px-3 py-2.5" active={marginSort.startsWith("category.")} order={marginSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleMarginSort("category")} />
                        <SortableTh label={t("pos.stockColumn")} align="end" className="px-3 py-2.5" active={marginSort.startsWith("stock.")} order={marginSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleMarginSort("stock")} />
                        <SortableTh label={t("products.cost")} align="end" className="px-3 py-2.5" active={marginSort.startsWith("cost.")} order={marginSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleMarginSort("cost")} />
                        <SortableTh label={t("products.price")} align="end" className="px-3 py-2.5" active={marginSort.startsWith("price.")} order={marginSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleMarginSort("price")} />
                        <SortableTh label={t("pos.marginColumn")} align="end" className="px-3 py-2.5" active={marginSort.startsWith("margin.")} order={marginSort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleMarginSort("margin")} />
                        <th className="px-3 py-2.5 text-end font-semibold">{t("products.actions")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neu-hairline">
                      {sortedBrowseProducts.map((product) => {
                        // Shared stockStatus from the API (lib/stock-status
                        // rule); fallback recomputes for cached rows.
                        const out = product.available <= 0;
                        const low =
                          !out &&
                          (product.stockStatus === "low" ||
                            (!product.stockStatus &&
                              product.available <= (product.minStockLevel ?? 0)));
                        const marginPct =
                          product.unitPrice > 0
                            ? ((product.unitPrice - product.costPrice) / product.unitPrice) * 100
                            : 0;
                        const marginTone =
                          marginPct >= 25
                            ? "text-neu-ink-green"
                            : marginPct >= 10
                              ? "text-neu-accent-ink"
                              : marginPct >= 0
                                ? "text-neu-ink-amber"
                                : "text-neu-ink-red";
                        return (
                          <tr key={product.id} className="transition-colors hover:bg-neu-sunken/70">
                            <td className="px-3 py-2">
                              <div className="flex min-w-0 items-center gap-3">
                                <ProductThumb src={product.imageUrl} name={product.name} className="h-9 w-9 rounded-lg flex-shrink-0" iconClassName="h-4 w-4" />
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-neu-primary">{product.name}</p>
                                  <p className="truncate pos-caption-xs-mono mt-0.5 text-neu-faint">
                                    {product.sku}
                                    {product.barcode ? ` · ${product.barcode}` : ""}
                                  </p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-xs text-neu-faint">{product.categoryName || "—"}</td>
                            <td className="px-3 py-2 text-end">
                              <span className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums">
                                {out
                                  ? <span className="pos-stock-badge pos-stock-badge-danger">{t("pos.outOfStock")}</span>
                                  : low
                                    ? <span className="pos-stock-badge pos-stock-badge-warning">{stockQtyText(product.available, product.unit)}</span>
                                    : stockQtyText(product.available, product.unit)}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-end text-xs tabular-nums text-neu-faint">
                              {formatCurrency(product.costPrice)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-end">
                              <span className="text-sm font-semibold tabular-nums text-neu-primary">
                                {formatCurrency(product.unitPrice)}
                              </span>
                              {perUnitSuffix(product.unit) && (
                                <span className="ms-0.5 text-[10px] text-neu-faint">{perUnitSuffix(product.unit)}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-end">
                              {product.unitPrice > 0 ? (
                                <span className={cn("text-xs font-semibold tabular-nums", marginTone)}>{Math.round(marginPct)}%</span>
                              ) : (
                                <span className="text-xs text-neu-faint">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => setDetailProduct(product)}
                                  title={t("pos.details")}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-neu-hairline text-neu-faint transition-colors hover:bg-neu-sunken hover:text-neu-primary"
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  </svg>
                                </button>
                                <Button size="sm" disabled={out} onClick={() => handleAddProduct(product)} className="h-7 px-2.5 text-xs">
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                  </svg>
                                  {t("pos.addItem")}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="pos-grid stagger">
                {browseProducts.map((product) => {
                  // Shared stockStatus from the API (lib/stock-status
                  // rule); fallback recomputes for cached rows.
                  const out = product.available <= 0;
                  const low =
                    !out &&
                    (product.stockStatus === "low" ||
                      (!product.stockStatus &&
                        product.available <= (product.minStockLevel ?? 0)));
                  return (
                    <div
                      key={product.id}
                      role="button"
                      tabIndex={out ? -1 : 0}
                      aria-disabled={out}
                      onClick={() => handleAddProduct(product)}
                      onKeyDown={(e) => {
                        if (!out && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          handleAddProduct(product);
                        }
                      }}
                      className={cn(
                        "group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-neu-bg text-start transition-all duration-200 neu-focus",
                        out
                          ? "cursor-not-allowed border-neu-hairline bg-neu-sunken/60 opacity-60 dark:opacity-50"
                          : "border-neu-hairline hover:border-neu-accent-line hover:shadow-lg hover:shadow-neu-hairline/60 hover:-translate-y-0.5 active:scale-[0.98] dark:hover:shadow-black/30"
                      )}
                    >
                      {/* Thumbnail */}
                      <div className="relative h-24 w-full overflow-hidden">
                        <div className="pos-card-image h-full w-full">
                          <ProductThumb src={product.imageUrl} name={product.name} className="h-full w-full rounded-none" iconClassName="h-8 w-8" />
                        </div>
                        {out ? (
                          <span className="absolute inset-0 flex items-center justify-center bg-neu-scrim/40 backdrop-blur-[1px]">
                            <span className="rounded-full bg-neu-scrim/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white">
                              {t("pos.out")}
                            </span>
                          </span>
                        ) : (
                          <span className="pointer-events-none absolute end-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-neu-accent-solid text-white shadow-md opacity-0 transition-all duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 group-active:scale-95 pos-card-add-float">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                            </svg>
                          </span>
                        )}
                        {/* Details quick-access (independent button) — always visible on touch, hover on pointer */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDetailProduct(product);
                          }}
                          title={t("pos.details")}
                          aria-label={t("pos.details")}
                          className="absolute start-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-neu-hairline/70 bg-neu-bg/90 text-neu-faint shadow-sm backdrop-blur transition-all duration-200 hover:text-neu-accent-ink hover:border-neu-accent-line neu-focus"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                        </button>
                      </div>
                      <div className="flex flex-1 flex-col gap-0.5 p-3">
                        <p className="line-clamp-2 min-h-[2.5em] text-[13px] font-medium leading-snug text-neu-primary">{product.name}</p>
                        <p className="truncate pos-caption-xs-mono text-neu-faint">{product.sku}</p>
                        <div className="mt-auto flex items-end justify-between gap-1 pt-1.5">
                          <span className="whitespace-nowrap text-sm font-bold tabular-nums text-neu-accent-ink">
                            {formatCurrency(product.unitPrice)}
                            {perUnitSuffix(product.unit) && (
                              <span className="text-[10px] font-medium text-neu-faint">{perUnitSuffix(product.unit)}</span>
                            )}
                          </span>
                          {out ? (
                            <span className="pos-stock-badge pos-stock-badge-danger">{t("pos.outOfStock")}</span>
                          ) : low ? (
                            <span className="pos-stock-badge pos-stock-badge-warning">
                              {t("pos.low")} · {stockQtyText(product.available, product.unit)}
                            </span>
                          ) : (
                            <span className="pos-stock-badge pos-stock-badge-ok">
                              {stockQtyText(product.available, product.unit)} {t("pos.left")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ DESKTOP RIGHT PANEL: Live Cart ═══ */}
      <aside className="pos-cart-rail hidden w-[340px] shrink-0 flex-col bg-neu-sunken/80 md:flex xl:w-[360px] backdrop-blur-sm">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-neu-hairline bg-neu-bg px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wide text-neu-primary">{t("pos.order")}</h2>
            {hasCart && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-neu-accent-solid px-1.5 py-0.5 text-[10px] font-bold leading-4 text-white shadow-sm">
                {cart.itemCount}
              </span>
            )}
          </div>
          {hasCart && (
            <Button
              variant="ghost"
              size="sm"
              onClick={cart.clearCart}
              className="h-7 text-xs text-neu-ink-red hover:bg-neu-wash-red"
            >
              {t("pos.clearCart")}
            </Button>
          )}
        </div>

        {/* Customer picker — search / quick-create / loyalty points */}
        <div className="shrink-0 border-b border-neu-hairline bg-neu-bg px-4 py-2.5">
          <CustomerPicker
            value={pickedCustomer}
            onSelect={(c) => {
              setPickedCustomer(c);
              cart.setCustomer(c?.id ?? null, c?.name ?? null);
            }}
          />
        </div>

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto p-3 pos-scroll">
          {cart.items.length === 0 ? (
            <EmptyState
              bare
              className="h-full"
              icon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              }
              title={t("pos.readyToSell")}
              description={t("pos.readyToSellHint")}
            />
          ) : (
            <div className="space-y-2">
              {cart.items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border bg-neu-bg p-3 shadow-xs",
                    flashItemId === item.productId ? "pos-flash border-neu-accent-line/60" : "border-neu-hairline"
                  )}
                >
                  <ProductThumb src={item.imageUrl} name={item.productName} className="h-12 w-12 rounded-lg flex-shrink-0 ring-1 ring-inset ring-neu-hairline/60" iconClassName="h-6 w-6" />

                  {/* Details */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-snug text-neu-primary">{item.productName}</p>
                    <p className="mt-0.5 text-xs tabular-nums text-neu-faint">
                      {formatCurrency(item.unitPrice)}
                      {perUnitSuffix(item.unit) && <span className="text-neu-faint">{perUnitSuffix(item.unit)}</span>}
                      {item.discountValue > 0 && (
                        <span className="ms-1 font-medium text-neu-ink-green">
                          ({item.discountType === "percentage" ? `${item.discountValue}% ${t("pos.off")}` : `${formatCurrency(item.discountValue)} ${t("pos.off")}`})
                        </span>
                      )}
                    </p>
                  </div>

                  {/* Quantity: stepper for whole units, unit-aware amount + edit for loose goods */}
                  <CartQtyControl
                    item={item}
                    editLabel={t("pos.editQty")}
                    onEdit={() => openCartQtyEditor(item)}
                    onDec={() => cart.updateItemQuantity(item.id, Math.max(0, item.quantity - 1))}
                    onInc={() => cart.updateItemQuantity(item.id, item.quantity + 1)}
                  />

                  {/* Line total + actions. min-w, not w-: a fixed 80/96px box
                      elided large line totals into "…" in the cart. */}
                  <div className="min-w-20 shrink-0 text-end sm:min-w-24">
                    <p className="pos-line-total whitespace-nowrap text-sm font-bold text-neu-primary">{formatCurrency(item.total)}</p>
                    <div className="mt-0.5 flex items-center justify-end gap-1">
                      <button
                        onClick={() => openDiscount(item.id)}
                        className="rounded px-0.5 text-[11px] font-medium text-neu-accent-ink transition-colors hover:text-neu-accent-ink-strong neu-focus"
                      >
                        {t("pos.discount")}
                      </button>
                      <span className="text-[10px] text-neu-faint">·</span>
                      <button
                        onClick={() => cart.removeItem(item.id)}
                        className="rounded px-0.5 text-[11px] font-medium text-neu-ink-red transition-colors neu-focus"
                      >
                        {t("pos.remove")}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Totals + Pay */}
        <div className="shrink-0 space-y-3 border-t border-neu-hairline bg-neu-bg p-4">
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between text-neu-faint">
              <span>{t("pos.subtotal")}</span>
              <span className="pos-money tabular-nums text-neu-primary">{formatCurrency(cart.subtotal)}</span>
            </div>
            {cart.taxAmount > 0 && (
              <div className="flex justify-between text-neu-faint">
                <span>{t("pos.tax")}</span>
                <span className="pos-money tabular-nums text-neu-primary">{formatCurrency(cart.taxAmount)}</span>
              </div>
            )}
            {cart.discountAmount > 0 && (
              <div className="flex justify-between text-neu-ink-green">
                <span className="font-medium">{t("pos.discount")}</span>
                <span className="pos-money tabular-nums">-{formatCurrency(cart.discountAmount)}</span>
              </div>
            )}
            <div className="border-t border-dashed border-neu-hairline pt-2.5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold uppercase tracking-wide text-neu-faint">{t("pos.total")}</span>
                <span className="pos-total-due text-2xl font-bold text-neu-accent-ink">{formatCurrency(finalTotal)}</span>
              </div>
            </div>
          </div>

          <Button
            variant="pos"
            className="w-full"
            disabled={!hasCart}
            onClick={() => {
              setAmountPaid(baseCentsToDisplayMajorStr(finalTotal, fx));
              setPaymentOpen(true);
            }}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
            </svg>
            {t("pos.pay")} {formatCurrency(finalTotal)}
          </Button>
        </div>
      </aside>

      {/* ═══ MOBILE CART DRAWER TRIGGER BAR ═══ */}
      {hasCart && (
        <div className="fixed bottom-0 start-0 end-0 z-30 border-t border-neu-hairline bg-neu-bg/95 px-4 py-3 safe-area-bottom shadow-[0_-4px_12px_-4px_rgb(0_0_0_/_0.08)] backdrop-blur-md md:hidden">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setMobileCartOpen(!mobileCartOpen)}
              className="flex min-w-0 items-center gap-2 rounded-lg py-1 pe-2 transition-colors active:scale-[0.98]"
              aria-expanded={mobileCartOpen}
            >
              <div className="relative">
                <svg className="h-6 w-6 text-neu-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
                </svg>
                {cart.itemCount > 0 && (
                  <span className="absolute -end-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-neu-accent-solid px-0.5 text-[10px] font-bold leading-none text-white shadow-sm">
                    {cart.itemCount > 99 ? "99+" : cart.itemCount}
                  </span>
                )}
              </div>
              <span className="truncate text-sm font-semibold text-neu-primary">
                {cart.itemCount} {t("pos.items")}
              </span>
              <svg className={cn("h-3.5 w-3.5 shrink-0 text-neu-faint transition-transform", mobileCartOpen && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <div className="flex shrink-0 items-center gap-3">
              <span className="pos-total-due text-lg font-bold text-neu-accent-ink">
                {formatCurrency(finalTotal)}
              </span>
              <Button
                type="button"
                variant="pos"
                size="sm"
                onClick={() => {
                  setAmountPaid(baseCentsToDisplayMajorStr(finalTotal, fx));
                  setPaymentOpen(true);
                }}
              >
                {t("pos.pay")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MOBILE CART DRAWER ═══ */}
      {mobileCartOpen && (
        <div
          ref={mobileCartRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("pos.order")}
          className="fixed inset-0 z-40 md:hidden"
          onClick={() => setMobileCartOpen(false)}
        >
          <div className="absolute inset-0 neu-dialog-overlay" />
          <div
            className="absolute bottom-0 start-0 end-0 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl bg-neu-bg shadow-2xl animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-neu-hairline px-4 py-3">
              <h3 className="text-sm font-semibold text-neu-primary">
                {t("pos.order")} ({cart.itemCount} {t("pos.items")})
              </h3>
              <button
                type="button"
                onClick={() => setMobileCartOpen(false)}
                className="rounded-lg p-1.5 text-neu-faint hover:bg-neu-sunken hover:text-neu-muted transition-colors"
                aria-label={t("common.close")}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Customer picker (mobile) */}
            {pickedCustomer && (
              <div className="shrink-0 border-b border-neu-hairline bg-neu-sunken px-4 py-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neu-accent-solid text-[10px] font-bold text-white">
                    {pickedCustomer.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-neu-primary">{pickedCustomer.name}</span>
                    {pickedCustomer.loyaltyPoints !== undefined && pickedCustomer.loyaltyPoints > 0 && (
                      <span className="flex items-center gap-1 truncate text-[10px] text-neu-accent-ink">
                        <StarIcon className="h-2.5 w-2.5 shrink-0" /> {pickedCustomer.loyaltyPoints} {t("pos.customerLoyaltyPoints")}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setPickedCustomer(null);
                      cart.setCustomer(null, null);
                    }}
                    className="shrink-0 rounded-md p-1 text-neu-faint hover:bg-neu-sunken hover:text-neu-ink-red transition-colors"
                    aria-label={t("pos.removeCustomer")}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-4 py-2 pos-scroll">
              {cart.items.length === 0 ? (
                <EmptyState bare className="py-8" title={t("pos.emptyCart")} />
              ) : (
                <div className="divide-y divide-neu-hairline">
                  {cart.items.map((item) => (
                    <div key={item.id} className="flex items-center gap-3 py-3">
                      <ProductThumb src={item.imageUrl} name={item.productName} className="h-10 w-10 rounded-lg flex-shrink-0" iconClassName="h-5 w-5" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-neu-primary">{item.productName}</p>
                        <p className="mt-0.5 text-xs tabular-nums text-neu-faint">
                          {formatCurrency(item.unitPrice)}
                          {perUnitSuffix(item.unit) && <span className="text-neu-faint">{perUnitSuffix(item.unit)}</span>}
                          {isWholeUnitProduct({ unit: item.unit, allowFractional: item.allowFractional }) ? (
                            <span> × {trimNumber(item.quantity)}</span>
                          ) : (
                            <span> · {lineQtyLabel(item.quantity, item.unit)}</span>
                          )}
                        </p>
                      </div>
                      <CartQtyControl
                        size="sm"
                        item={item}
                        editLabel={t("pos.editQty")}
                        onEdit={() => openCartQtyEditor(item)}
                        onDec={() => cart.updateItemQuantity(item.id, Math.max(0, item.quantity - 1))}
                        onInc={() => cart.updateItemQuantity(item.id, item.quantity + 1)}
                      />
                      <span className="pos-line-total min-w-16 shrink-0 text-end text-sm font-bold text-neu-primary">
                        {formatCurrency(item.total)}
                      </span>
                      <button
                        type="button"
                        onClick={() => cart.removeItem(item.id)}
                        className="rounded-md p-1.5 text-neu-ink-red transition-colors hover:bg-neu-wash-red"
                        aria-label={t("pos.remove")}
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {hasCart && (
              <div className="shrink-0 space-y-2 border-t border-neu-hairline bg-neu-sunken px-4 py-3 pb-4 safe-area-bottom">
                <div className="flex justify-between text-sm text-neu-faint">
                  <span>{t("pos.subtotal")}</span>
                  <span className="pos-money tabular-nums text-neu-primary">{formatCurrency(cart.subtotal)}</span>
                </div>
                {cart.taxAmount > 0 && (
                  <div className="flex justify-between text-sm text-neu-faint">
                    <span>{t("pos.tax")}</span>
                    <span className="pos-money tabular-nums text-neu-primary">{formatCurrency(cart.taxAmount)}</span>
                  </div>
                )}
                {cart.discountAmount > 0 && (
                  <div className="flex justify-between text-sm text-neu-ink-green">
                    <span className="font-medium">{t("pos.discount")}</span>
                    <span className="pos-money tabular-nums">-{formatCurrency(cart.discountAmount)}</span>
                  </div>
                )}
                <div className="flex items-baseline justify-between border-t border-dashed border-neu-hairline pt-2">
                  <span className="text-base font-bold text-neu-primary">{t("pos.total")}</span>
                  <span className="pos-total-due text-lg font-bold text-neu-accent-ink">{formatCurrency(finalTotal)}</span>
                </div>
                <Button
                  type="button"
                  variant="pos"
                  className="w-full"
                  onClick={() => {
                    setMobileCartOpen(false);
                    setAmountPaid(baseCentsToDisplayMajorStr(finalTotal, fx));
                    setPaymentOpen(true);
                  }}
                >
                  {t("pos.pay")} {formatCurrency(finalTotal)}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ PAYMENT MODAL ═══ */}
      {/* ═══ PROCESS PAYMENT ═══ */}
      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent size="md" height="tall">
          <DialogHeader>
            <DialogTitle>{t("pos.processPayment")}</DialogTitle>
          </DialogHeader>
          {/* Middle content scrolls inside DialogBody; the footer stays pinned. */}
          <DialogBody className="space-y-4">
            {/* Order Total */}
            <div className="rounded-xl bg-neu-sunken p-4 text-center ring-1 ring-inset ring-neu-hairline/70">
              <p className="text-xs font-medium uppercase tracking-wide text-neu-faint">
                {t("pos.amountDue")} · {cart.itemCount} {t("pos.items")}
              </p>
              {loyaltyValueCents > 0 && (
                <p className="pos-money mt-1 text-xs text-neu-ink-green line-through">
                  {formatCurrency(cart.total)}
                </p>
              )}
              <p className="pos-total-due mt-1.5 text-3xl font-extrabold text-neu-accent-ink">
                {formatCurrency(finalTotal)}
              </p>
              {loyaltyValueCents > 0 && (
                <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-neu-ink-green">
                  <StarIcon className="h-3 w-3" /> {loyaltyRedeem} {t("pos.loyaltyPoints")} {t("pos.loyaltyApplied")}
                </p>
              )}
            </div>

            {/* Customer khata balance — the cashier should see prior dues
                BEFORE deciding how much cash to collect */}
            {pickedCustomer && (pickedCustomer.outstandingBalance ?? 0) > 0 && (
              <div className="rounded-xl border border-neu-ink-amber/35 bg-neu-wash-amber p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-neu-ink-amber">
                    {t("pos.customerOutstanding")} · {pickedCustomer.name}
                  </span>
                  <span className="text-sm font-bold tabular-nums text-neu-ink-amber">
                    {formatCurrency(pickedCustomer.outstandingBalance ?? 0)}
                  </span>
                </div>
                {/* Collect old dues along with this sale — only from the
                    over-tender (cash beyond the current bill). */}
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={settleInput}
                    onChange={(e) => setSettleInput(e.target.value)}
                    placeholder="0.00"
                    className="h-8 flex-1"
                    label={t("pos.collectOutstanding")}
                  />
                  <button
                    type="button"
                    onClick={() => setSettleInput((maxSettleCents / 100).toFixed(2))}
                    disabled={maxSettleCents <= 0}
                    className="shrink-0 rounded-lg border border-neu-ink-amber/35 bg-neu-bg px-2.5 py-1.5 text-[11px] font-semibold text-neu-ink-amber transition-colors hover:bg-neu-wash-amber disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t("pos.collectAll")} · {formatCurrency(maxSettleCents)}
                  </button>
                </div>
                {settleEffective > 0 && (
                  <p className="mt-1.5 text-[11px] font-medium tabular-nums text-neu-ink-amber">
                    {t("pos.collectingOldDues")}: {formatCurrency(settleEffective)}
                  </p>
                )}
                {settleCents > maxSettleCents && (
                  <p className="mt-1 text-[11px] text-neu-faint">{t("pos.collectClamped")}</p>
                )}
              </div>
            )}

            {/* Loyalty Redemption — only when a customer is attached */}
            {pickedCustomer && (
              <div className="rounded-xl border border-neu-accent-line bg-neu-accent-wash/60 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-neu-accent-ink-strong">
                    <StarIcon className="h-3.5 w-3.5" /> {t("pos.redeemLoyalty")}
                  </span>
                  <span className="text-xs tabular-nums text-neu-faint">
                    {t("pos.loyaltyBalance")}: <strong>{pickedCustomer.loyaltyPoints ?? 0}</strong>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={Math.min(pickedCustomer.loyaltyPoints ?? 0, cart.total)}
                    step={1}
                    value={loyaltyInputValue}
                    placeholder={`0 ${t("pos.loyaltyPoints")}`}
                    onChange={(e) => {
                      const n = Math.max(0, Math.floor(parseFloat(e.target.value) || 0));
                      setLoyaltyRedeem(
                        Math.min(n, pickedCustomer.loyaltyPoints ?? 0, cart.total)
                      );
                    }}
                    className="h-9 flex-1"
                  />
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setLoyaltyRedeem(Math.min(pickedCustomer.loyaltyPoints ?? 0, cart.total))
                      }
                      className="shrink-0 rounded-lg border border-neu-accent-line bg-neu-bg px-2.5 py-1.5 text-[11px] font-semibold text-neu-accent-ink-strong transition-colors hover:bg-neu-accent-wash"
                    >
                      {t("pos.useAll")}
                    </button>
                    {loyaltyValueCents > 0 && (
                      <button
                        type="button"
                        onClick={() => setLoyaltyRedeem(0)}
                        className="shrink-0 rounded-lg border border-neu-hairline bg-neu-bg px-2.5 py-1.5 text-[11px] font-medium text-neu-faint transition-colors hover:bg-neu-sunken"
                      >
                        {t("pos.clear")}
                      </button>
                    )}
                  </div>
                </div>
                {loyaltyValueCents > 0 && (
                  <p className="mt-2 text-xs tabular-nums text-neu-ink-green">
                    {t("pos.loyaltyValue")}: -{formatCurrency(loyaltyValueCents)}
                  </p>
                )}
              </div>
            )}

            {/* Payment Methods */}
            <div className="grid grid-cols-2 gap-2">
              {paymentMethods.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPaymentMethod(id)}
                  aria-pressed={paymentMethod === id}
                  className={cn("pos-pay-tile", paymentMethod === id && "pos-pay-tile-active")}
                >
                  <PaymentMethodIcon id={id} className="h-5 w-5 shrink-0" />
                  <span className="truncate">{t(`pos.paymentMethod.${id}`)}</span>
                </button>
              ))}
            </div>

            {/* Cash Payment */}
            {paymentMethod === "cash" && (
              <div className="space-y-3">
                <Input
                  ref={amountInputRef}
                  label={t("pos.amountReceived")}
                  type="number"
                  value={amountPaid}
                  onChange={(e) => setAmountPaid(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && amountPaidCents >= finalTotal) {
                      e.preventDefault();
                      processPayment();
                    }
                  }}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                />
            {/* Quick Cash Buttons — only denominations that actually
                settle the bill (smaller chips are noise/mis-taps). */}
            <div className="pos-cash-quick">
              {quickCashAmounts
                .filter((amt) => displayMajorToBaseCents(amt, fx) + chipTol >= finalTotal)
                .map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setAmountPaid(String(amt))}
                    className="pos-cash-quick-btn border border-neu-hairline bg-neu-bg px-3 tabular-nums text-neu-muted hover:bg-neu-sunken"
                  >
                    {amt}
                  </button>
                ))}
                  {nextBill && displayMajorToBaseCents(nextBill, fx) > finalTotal + chipTol && (
                    <button
                      type="button"
                      onClick={() => setAmountPaid(String(nextBill))}
                      className="pos-cash-quick-btn border border-neu-accent-line bg-neu-accent-wash px-3 font-semibold text-neu-accent-ink-strong"
                    >
                      {t("pos.roundUp")} · {nextBill}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAmountPaid((finalTotal / 100).toFixed(2))}
                    className="pos-cash-quick-btn border border-neu-accent-line bg-neu-accent-wash px-3 text-neu-accent-ink-strong"
                  >
                    {t("pos.exact")} · {baseCentsToDisplayMajorStr(finalTotal, fx)}
                  </button>
                </div>
                {/* Change Due */}
                {amountPaidCents >= finalTotal && (
                  <div className="rounded-xl bg-neu-wash-green p-3 text-center">
                    <p className="text-xs font-medium text-neu-ink-green">{t("pos.changeDue")}</p>
                    <p className="mt-0.5 text-xl font-bold tabular-nums text-neu-ink-green">
                      {formatCurrency(changeDue)}
                    </p>
                  </div>
                )}
                {/* Short payment WITH a customer → credit (khata) due */}
                {canAcceptShortPayment && amountPaidCents > 0 && amountPaidCents < finalTotal && (
                  <div className="rounded-xl border border-neu-ink-amber/35 bg-neu-wash-amber p-3 text-center">
                    <p className="text-xs font-semibold text-neu-ink-amber">
                      {t("pos.creditDueTitle")}
                    </p>
                    <p className="mt-0.5 text-xl font-bold tabular-nums text-neu-ink-amber">
                      {formatCurrency(dueAmount)}
                    </p>
                    <p className="mt-1 text-[11px] text-neu-ink-amber">
                      {t("pos.creditDueDesc")} · {pickedCustomer?.name}
                    </p>
                  </div>
                )}
                {/* Short payment WITHOUT a customer → not allowed */}
                {!canAcceptShortPayment && amountPaidCents > 0 && amountPaidCents < finalTotal && (
                  <div className="rounded-xl border border-neu-ink-red/35 bg-neu-wash-red p-3 text-center">
                    <p className="text-[11px] font-medium text-neu-ink-red">
                      {t("pos.fullPaymentRequired")}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Card/Wallet Payment */}
            {paymentMethod !== "cash" && (
              <div className="rounded-xl bg-neu-sunken p-4 text-center text-sm text-neu-faint">
                <p className="text-xs font-medium text-neu-faint">
                  {t("pos.processPaymentOf")}
                </p>
                <p className="mt-1 text-base font-semibold text-neu-primary">
                  {t(`pos.paymentMethod.${paymentMethod}`)} · {formatCurrency(finalTotal)}
                </p>
              </div>
            )}
          </DialogBody>

            {/* Footer — pinned (shrink-0); the
                confirm button adapts to the payment outcome */}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setPaymentOpen(false)}>
                {t("common.cancel")}
              </Button>
              {isCreditSale ? (
                <Button
                  variant="secondary"
                  loading={processing}
                  className="border-neu-ink-amber text-neu-ink-amber hover:bg-neu-wash-amber"
                  onClick={processPayment}
                >
                  {t("pos.saveWithDue")} · {formatCurrency(dueAmount)}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  loading={processing}
                  disabled={paymentMethod === "cash" ? amountPaidCents < finalTotal : false}
                  onClick={processPayment}
                >
                  {t("pos.completePayment")}
                </Button>
              )}
            </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ RECEIPT MODAL ═══ */}
      <Dialog open={receiptOpen} onOpenChange={() => {}}>
        <DialogContent size="sm">
          {/* Print CSS: when printing, show only the receipt */}
          <style>{`
            @media print {
              body * { visibility: hidden; }
              .pos-receipt-print, .pos-receipt-print * { visibility: visible; }
              .pos-receipt-print { position: absolute; inset: 0; width: 100%; }
            }
          `}</style>
          <DialogBody className="p-6 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-neu-wash-green ring-8 ring-neu-ink-green/30">
              <svg className="h-8 w-8 text-neu-ink-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-lg font-bold tracking-tight text-neu-primary">{t("pos.paymentComplete")}</h3>
            <p className="mt-1 font-mono text-sm font-medium text-neu-faint">
              {t("pos.orderNumberShort")} {completedOrder?.orderNumber}
            </p>
            {completedOrder?.customer?.name && (
              <p className="mt-0.5 text-xs font-medium text-neu-accent-ink">
                {t("pos.customerLabel")}: {completedOrder.customer.name}
              </p>
            )}

            {/* Receipt Preview */}
            {completedOrder && (
              /* LTR island: this previews `print-pos-receipt.ts`, and that template is
                 `lang="en"` with physical geometry — the paper does not mirror when the
                 UI does. A mirrored preview would misrepresent the customer's copy, so
                 the facsimile declares the paper's direction for its whole subtree.
                 `text-start` inside it therefore means the paper's left, and the
                 `justify-between` rows keep each amount on the printed side. */
              <div dir="ltr" className="pos-receipt-preview mx-auto mt-4 rounded-lg border border-neu-hairline bg-neu-bg p-4 text-start shadow-sm">
                <div className="mb-2 border-b border-dashed border-neu-hairline pb-2 text-center">
                  <p className="text-sm font-bold tracking-wide text-neu-primary">
                    {storeReceipt.storeName || t("receiptSettings.yourStore")}
                  </p>
                  {storeReceipt.storeAddress && (
                    <p className="text-[10px] text-neu-faint">{storeReceipt.storeAddress}</p>
                  )}
                  {storeReceipt.storePhone && (
                    <p className="text-[10px] text-neu-faint">{storeReceipt.storePhone}</p>
                  )}
                  <p className="text-[10px] text-neu-faint">
                    {new Date(completedOrder.createdAt).toLocaleString()}
                  </p>
                </div>
                {storeReceipt.receiptHeader && (
                  <p className="mb-2 text-center text-[10px] font-medium text-neu-faint">
                    {storeReceipt.receiptHeader}
                  </p>
                )}
                {completedOrder.items.map((item, i) => (
                  <div key={i} className="py-0.5">
                    <div className="flex justify-between text-xs">
                      <span className="me-2 truncate">{item.productName}</span>
                      <span className="shrink-0 tabular-nums text-neu-primary">
                        {formatCurrency(item.total)}
                      </span>
                    </div>
                    <div className="ps-1 text-[10px] tabular-nums text-neu-faint">
                      {lineQtyLabel(item.quantity, item.unit)} × {formatCurrency(item.unitPrice)}
                      {perUnitSuffix(item.unit)}
                    </div>
                  </div>
                ))}
                <div className="mt-2 border-t-2 border-dashed border-neu-hairline pt-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-neu-faint">{t("pos.subtotal")}</span>
                    <span className="tabular-nums text-neu-primary">
                      {formatCurrency(completedOrder.subtotal)}
                    </span>
                  </div>
                  {completedOrder.discountAmount > 0 && (
                    <div className="flex justify-between text-xs text-neu-ink-green">
                      <span>{t("pos.discount")}</span>
                      <span className="tabular-nums">
                        -{formatCurrency(completedOrder.discountAmount)}
                      </span>
                    </div>
                  )}
                  {(completedOrder.loyaltyRedeemed ?? 0) > 0 && (
                    <div className="flex justify-between text-xs text-neu-ink-green">
                      <span className="inline-flex items-center gap-1">
                        <StarIcon className="h-3 w-3" /> {t("pos.loyalty")} ({completedOrder.loyaltyPointsRedeemed ?? 0})
                      </span>
                      <span className="tabular-nums">
                        -{formatCurrency(completedOrder.loyaltyRedeemed ?? 0)}
                      </span>
                    </div>
                  )}
                  {completedOrder.taxAmount > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-neu-faint">{t("pos.tax")}</span>
                      <span className="tabular-nums text-neu-primary">
                        {formatCurrency(completedOrder.taxAmount)}
                      </span>
                    </div>
                  )}
                  <div className="mt-1 flex justify-between text-sm font-bold">
                    <span className="text-neu-primary">{t("pos.total")}</span>
                    <span className="tabular-nums text-neu-accent-ink">
                      {formatCurrency(completedOrder.total)}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between text-xs">
                    <span className="text-neu-faint">{t("pos.payment")}</span>
                    <span className="text-neu-primary">
                      {t(`pos.paymentMethod.${completedOrder.paymentMethod}`)}
                    </span>
                  </div>
                  {(completedOrder.paidAmount ?? 0) > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-neu-faint">{t("pos.amountReceived")}</span>
                      <span className="tabular-nums text-neu-primary">
                        {formatCurrency(completedOrder.paidAmount)}
                      </span>
                    </div>
                  )}
                  {(completedOrder.dueAmount ?? 0) > 0 && (
                    <div className="flex justify-between text-xs font-semibold text-neu-ink-amber">
                      <span>{t("pos.dueCredit")}</span>
                      <span className="tabular-nums">
                        {formatCurrency(completedOrder.dueAmount ?? 0)}
                      </span>
                    </div>
                  )}
                  {(completedOrder.customer?.outstandingBalance ?? 0) > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-neu-faint">{t("pos.outstandingBalance")}</span>
                      <span className="tabular-nums text-neu-ink-amber">
                        {formatCurrency(completedOrder.customer?.outstandingBalance ?? 0)}
                      </span>
                    </div>
                  )}
                  {completedOrder.changeDue > 0 && (
                    <div className="flex justify-between text-xs text-neu-ink-green">
                      <span>{t("pos.change")}</span>
                      <span className="tabular-nums">
                        {formatCurrency(completedOrder.changeDue)}
                      </span>
                    </div>
                  )}
                  {completedOrder.user?.name && (
                    <div className="mt-1 flex justify-between text-xs">
                      <span className="text-neu-faint">{t("pos.cashier")}</span>
                      <span className="text-neu-primary">
                        {completedOrder.user.name}
                      </span>
                    </div>
                  )}
                  {storeReceipt.receiptFooter && (
                    <p className="mt-2 text-center text-[10px] text-neu-faint">
                      {storeReceipt.receiptFooter}
                    </p>
                  )}
                </div>
              </div>
            )}

              <div className="no-print mt-6 flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                onClick={() => {
                  if (!completedOrder) return;
                  printPOSReceipt(
                    {
                      orderNumber: completedOrder.orderNumber,
                      createdAt: completedOrder.createdAt,
                      subtotal: completedOrder.subtotal,
                      taxAmount: completedOrder.taxAmount,
                      discountAmount: completedOrder.discountAmount,
                      total: completedOrder.total,
                      paymentMethod: completedOrder.paymentMethod,
                      amountPaid: completedOrder.paidAmount,
                      changeDue: completedOrder.changeDue,
                      dueAmount: completedOrder.dueAmount ?? 0,
                      paymentStatus: completedOrder.paymentStatus,
                      loyaltyRedeemed: completedOrder.loyaltyRedeemed ?? 0,
                      loyaltyPointsRedeemed: completedOrder.loyaltyPointsRedeemed ?? 0,
                      user: completedOrder.user,
                      customer: completedOrder.customer ?? null,
                      items: completedOrder.items.map((it) => ({
                        productName: it.productName,
                        quantity: it.quantity,
                        unit: it.unit,
                        unitPrice: it.unitPrice,
                        total: it.total,
                      })),
                    },
                    {
                      storeName: storeReceipt.storeName || t("app.name"),
                      storeAddress: storeReceipt.storeAddress || undefined,
                      storePhone: storeReceipt.storePhone || undefined,
                      receiptHeader: storeReceipt.receiptHeader || undefined,
                      receiptFooter: storeReceipt.receiptFooter || undefined,
                      receiptQrPayment: storeReceipt.receiptQrPayment || undefined,
                    }
                  );
                }}
              >                  {t("pos.printReceipt")}
              </Button>
              <Button className="flex-1 font-semibold" onClick={newTransaction}>
                {t("pos.newSale")}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* ═══ DISCOUNT MODAL ═══ */}
      <Dialog open={discountModalOpen} onOpenChange={setDiscountModalOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("pos.applyDiscount")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="pos-segmented w-full" role="group" aria-label={t("pos.applyDiscount")}>
              <button
                type="button"
                aria-pressed={discountType === "percentage"}
                onClick={() => setDiscountType("percentage")}
                className={cn("pos-segmented-btn", discountType === "percentage" && "active")}
              >
                {t("pos.percentage")} %
              </button>
              <button
                type="button"
                aria-pressed={discountType === "fixed"}
                onClick={() => setDiscountType("fixed")}
                className={cn("pos-segmented-btn", discountType === "fixed" && "active")}
              >
                {t("pos.fixedAmount")}
              </button>
            </div>
            <Input
              type="number"
              placeholder={discountType === "percentage" ? t("pos.enterPercent") : t("pos.enterAmount")}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              min="0"
              max={discountType === "percentage" ? "100" : undefined}
              hint={discountType === "fixed" ? (isDisplayConverted(fx) ? t("currency.typedIn", { code: displayCurrencyCode }) : undefined) : undefined}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDiscountModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={applyDiscount}>{t("common.apply")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ UNIT-QUANTITY DIALOG (weight / amount-of-money sales) ═══ */}
      {qtyDialog && (
        <UnitQuantityDialog
          product={qtyDialog.product}
          maxQty={qtyDialog.maxQty}
          initialQty={qtyDialog.initialQty}
          editing={Boolean(qtyDialog.editItemId)}
          onConfirm={commitQuantity}
          onClose={() => setQtyDialog(null)}
          fx={fx}
          displayCode={displayCurrencyCode}
        />
      )}

      {/* ═══ PRODUCT DETAILS DIALOG ═══ */}
      {detailProduct && (
        <ProductDetailDialog
          product={detailProduct}
          onClose={() => setDetailProduct(null)}
          onAdd={(p) => {
            setDetailProduct(null);
            handleAddProduct(p);
          }}
          onAddVariant={(p, v) => {
            setDetailProduct(null);
            handleAddProduct(p, v);
          }}
        />
      )}            {/* ═══ BARCODE SCANNER DIALOG ═══ */}
      <Dialog open={scannerOpen} onOpenChange={setScannerOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("pos.scanToAdd")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <BarcodeScanner
              onScan={(value) => {
                // Auto-resolve + add to cart — no manual Enter needed.
                void resolveScan(value);
              }}
              onClose={() => setScannerOpen(false)}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* ═══ CASHIER DRAWER ═══ */}
      <Dialog open={cashierOpen} onOpenChange={(o) => { if (!o) setCashierOpen(false); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("pos.cashier")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {/* Cashier identity — pulled from the signed-in session */}
            <div className="flex items-center gap-3 rounded-lg border border-neu-hairline bg-neu-sunken p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neu-accent-wash text-neu-accent-ink-strong">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-neu-faint uppercase tracking-wide">{t("pos.cashier")}</p>
                <p className="text-sm font-semibold text-neu-primary truncate">
                  {session?.user?.name ?? t("pos.notLoggedIn")}
                </p>
              </div>
            </div>

            {/* Float cash — registers a starting cash float for the shift */}
            <div>
              <label className="text-sm font-medium text-neu-primary">{t("pos.cashFloat")} <span className="text-neu-faint font-normal">({t("common.optional")})</span></label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={cashFloat}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setCashFloat(Number.isFinite(v) && v >= 0 ? v : 0);
                }}
                hint={t("pos.cashFloatHint")}
              />
            </div>

            {/* Session / shift note */}
            <div>
              <label className="text-sm font-medium text-neu-primary">{t("pos.shiftNote")} <span className="text-neu-faint font-normal">({t("common.optional")})</span></label>
              <textarea
                className="mt-1.5 min-h-[72px] w-full rounded-lg border border-neu-hairline bg-neu-bg px-3 py-2 text-sm placeholder:text-neu-faint neu-focus"
                placeholder={t("pos.shiftNotePlaceholder")}
                value={shiftNote}
                onChange={(e) => setShiftNote(e.target.value)}
                rows={3}
              />
              <p className="mt-1 text-xs text-neu-faint">{t("pos.shiftNoteHint")}</p>
            </div>

            {/* Live summary — what the register will record */}
            <div className="rounded-lg border border-neu-accent-line bg-neu-accent-wash p-3">
              <p className="text-xs font-medium text-neu-accent-ink uppercase tracking-wide">{t("pos.shiftSummary")}</p>
              <div className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-neu-faint">{t("pos.cashier")}</span>
                  <span className="font-medium text-neu-primary">
                    {session?.user?.name ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neu-faint">{t("pos.cashFloat")}</span>
                  <span className="font-medium tabular-nums text-neu-primary">
                    {/* The input is in the currency the cashier SEES — convert
                        to base cents before formatting (formatCurrency takes
                        cents; the raw typed 100 used to render as 1.00). */}
                    {cashFloat > 0
                      ? formatCurrency(displayMajorToBaseCents(cashFloat, fx))
                      : t("pos.notSet")}
                  </span>
                </div>
                {shiftNote && (
                  <div className="flex justify-between">
                    <span className="text-neu-faint">{t("pos.shiftNote")}</span>
                    <span className="truncate font-medium text-neu-primary">{shiftNote}</span>
                  </div>
                )}
              </div>
            </div>
          </DialogBody>
          <DialogFooter className="dark:bg-neu-sunken/40">
            <Button variant="secondary" onClick={() => setCashierOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={saveCashierSession}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}