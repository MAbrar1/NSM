/* ═══════════════════════════════════════════════════════════════
   RECEIPT SNAPSHOT + CONTENT HASH
   The receipt's source of truth is an immutable snapshot frozen at
   issue time (inside the sale transaction). Reprints render from
   snapshot + templateVersion — never from live tables — so a later
   product rename, price change or customer edit cannot rewrite
   history.

   content_hash = SHA-256(canonicalSnapshotJson + templateVersion)
   - Canonical: stable key order (JSON.stringify of a sorted-key
     object), so the same data always hashes the same.
   - Excludes the reprint marker and fiscal fields by construction:
     those never enter the snapshot.
   - Verified before every reprint; mismatch blocks + audit entry.
   ═══════════════════════════════════════════════════════════════ */

import { createHash } from "crypto";

/** Current receipt template version. A layout change bumps this. */
export const RECEIPT_TEMPLATE_VERSION = 1;

/** Stable, deep-sorted JSON — the canonical form for hashing.
 *  Recursion sorts object keys at every depth, so the same data
 *  always hashes the same regardless of insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** SHA-256 hex of canonical(snapshot) + templateVersion. */
export function computeReceiptContentHash(
  snapshot: ReceiptSnapshot | Record<string, unknown>,
  templateVersion: number
): string {
  return createHash("sha256")
    .update(canonicalJson(snapshot))
    .update(`|v${templateVersion}`)
    .digest("hex");
}

/**
 * Verify a snapshot against a stored hash (used before every reprint).
 * Returns false on any mismatch — caller blocks and logs.
 */
export function verifyReceiptContentHash(
  snapshot: ReceiptSnapshot | Record<string, unknown>,
  templateVersion: number,
  storedHash: string
): boolean {
  const actual = computeReceiptContentHash(snapshot, templateVersion);
  return actual === storedHash;
}

/* ─── Snapshot shape ─────────────────────────────────────────────
   Everything the template renders, frozen at issue time. Amounts are
   integer cents; formatting happens only at render (money helpers),
   never in the template. */

export interface ReceiptSnapshotItem {
  productName: string;
  sku: string;
  quantity: number;
  unit: string;
  unitPrice: number; // cents
  discountAmount: number; // cents
  taxRate: number;
  taxAmount: number; // cents
  total: number; // cents
}

export interface ReceiptSnapshot {
  /** receipt metadata */
  receiptNo: string;
  terminalId: string;
  issuedAt: string; // ISO (UTC) — display converts to store timezone
  language: "en" | "ur" | "bilingual";

  /** frozen parties */
  cashierName: string;
  customerName: string | null;
  customerLoyaltyBalance: number; // points, frozen at sale

  /** frozen money (integer cents) */
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  loyaltyRedeemed: number;
  loyaltyPointsRedeemed: number;
  total: number;
  paidAmount: number;
  changeAmount: number;
  dueAmount: number;
  paymentStatus: string;

  /** frozen lines (price/tax/cost snapshots) */
  items: ReceiptSnapshotItem[];

  /** store identity frozen at issue (header/footer already localized) */
  storeName: string;
  storeAddress: string | null;
  storePhone: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  qrPaymentPayload: string | null;
}

/**
 * Build the frozen snapshot from the just-created order (inside the
 * sale transaction's returned shape) plus the store settings row.
 * No live reads after this point — the snapshot IS the record.
 */
export function buildReceiptSnapshot(args: {
  receiptNo: string;
  terminalId: string;
  issuedAt: Date;
  language: "en" | "ur" | "bilingual";
  order: {
    subtotal: number;
    taxAmount: number;
    discountAmount: number;
    total: number;
    paidAmount: number;
    changeAmount: number;
    dueAmount: number;
    paymentStatus: string;
    loyaltyRedeemed: number;
    loyaltyPointsRedeemed: number;
    items: Array<{
      productName: string;
      sku: string;
      quantity: number;
      unit: string;
      unitPrice: number;
      discountAmount: number;
      taxRate: number;
      taxAmount: number;
      total: number;
    }>;
  };
  cashierName: string;
  customerName: string | null;
  customerLoyaltyBalance: number;
  settings: {
    storeName: string;
    storeAddress: string | null;
    storePhone: string | null;
    receiptHeader: string | null;
    receiptFooter: string | null;
    receiptQrPayment: string | null;
  };
}): ReceiptSnapshot {
  return {
    receiptNo: args.receiptNo,
    terminalId: args.terminalId,
    issuedAt: args.issuedAt.toISOString(),
    language: args.language,
    cashierName: args.cashierName,
    customerName: args.customerName,
    customerLoyaltyBalance: args.customerLoyaltyBalance,
    subtotal: args.order.subtotal,
    discountAmount: args.order.discountAmount,
    taxAmount: args.order.taxAmount,
    loyaltyRedeemed: args.order.loyaltyRedeemed,
    loyaltyPointsRedeemed: args.order.loyaltyPointsRedeemed,
    total: args.order.total,
    paidAmount: args.order.paidAmount,
    changeAmount: args.order.changeAmount,
    dueAmount: args.order.dueAmount,
    paymentStatus: args.order.paymentStatus,
    items: args.order.items.map((it) => ({
      productName: it.productName,
      sku: it.sku,
      quantity: it.quantity,
      unit: it.unit,
      unitPrice: it.unitPrice,
      discountAmount: it.discountAmount,
      taxRate: it.taxRate,
      taxAmount: it.taxAmount,
      total: it.total,
    })),
    storeName: args.settings.storeName,
    storeAddress: args.settings.storeAddress,
    storePhone: args.settings.storePhone,
    receiptHeader: args.settings.receiptHeader,
    receiptFooter: args.settings.receiptFooter,
    qrPaymentPayload: args.settings.receiptQrPayment,
  };
}
