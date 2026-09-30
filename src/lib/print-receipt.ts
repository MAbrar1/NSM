import { formatCurrencyBase, formatDate } from "@/lib/utils";
import { lineQtyLabel } from "@/lib/units";

/* ═══════════════════════════════════════════════════════════════
   PRINT REFUND RECEIPTS
   Opens a clean, receipt-styled print window for one or more refund
   records (full or partial). Locale-aware: the caller passes
   pre-localized label strings so the same helper serves EN + UR
   without coupling to React.
   ═══════════════════════════════════════════════════════════════ */

export interface PrintReceiptLine {
  productName: string;
  qtyLabel: string; // already formatted + unit-aware ("2 kg", "0.385 kg")
  unitPriceLabel: string; // formatted unit price
  totalLabel: string; // formatted line total
}

export interface PrintReceiptOrder {
  orderNumber: string;
  dateLabel: string;
  customerLabel: string;
  cashierLabel: string;
  refundedByLabel?: string;
  reasonLabel: string;
  statusLabel: string;
  items: PrintReceiptLine[];
  refundedLabel: string; // formatted refunded amount
  totalLabel?: string; // formatted original total (partial refunds)
}

export interface PrintReceiptSettings {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  receiptHeader?: string;
  receiptFooter?: string;
}

export interface PrintReceiptLabels {
  order: string;
  customer: string;
  cashier: string;
  refundedBy: string;
  reason: string;
  items: string;
  refundedAmount: string;
  originalTotal: string;
  date: string;
  status: string;
  noReason: string;
  walkIn: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ────────────────────────────────────────────────────────────────
   Shared entry point for both screens (Orders + Refunds). Fetches
   the store settings, maps the order rows into receipt blocks and
   prints them. `t` is the app's i18n translate function.
   ──────────────────────────────────────────────────────────────── */

export interface PrintSourceOrder {
  orderNumber: string;
  status: string;
  refundReason?: string | null;
  refundedAt?: string | null;
  createdAt: string;
  refundedAmount?: number;
  total: number;
  user?: { name: string } | null;
  refundedBy?: { name: string } | null;
  customer?: { name: string } | null;
  items: Array<{
    productName: string;
    quantity: number;
    unit?: string | null;
    unitPrice: number;
    total: number;
  }>;
}

type TranslateFn = (key: string) => string;

export async function printRefundReceiptsForOrders(
  orders: PrintSourceOrder[],
  t: TranslateFn
): Promise<void> {
  if (orders.length === 0) return;

  let settings: PrintReceiptSettings = {
    storeName: t("app.name"),
  };
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    const s = data.settings ?? {};
    settings = {
      storeName: s.storeName || t("app.name"),
      storeAddress: s.storeAddress || undefined,
      storePhone: s.storePhone || undefined,
      receiptHeader: s.receiptHeader || undefined,
      receiptFooter: s.receiptFooter || undefined,
    };
  } catch {
    // Settings are cosmetic for a receipt — fall back to the app name
  }

  const labels: PrintReceiptLabels = {
    order: t("orders.orderNumber"),
    customer: t("orders.customer"),
    cashier: t("orders.cashier"),
    refundedBy: t("refunds.refundedBy"),
    reason: t("refunds.reason"),
    items: t("orders.items"),
    refundedAmount: t("refunds.refundedAmount"),
    originalTotal: t("orders.total"),
    date: t("orders.date"),
    status: t("orders.status"),
    noReason: t("refunds.noReason"),
    walkIn: t("orders.walkInCustomer"),
  };

  const receiptOrders: PrintReceiptOrder[] = orders.map((o) => {
    const refundedAmount = o.refundedAmount || (o.status === "refunded" ? o.total : 0);
    const partial = o.status === "partially_refunded";
    return {
      orderNumber: o.orderNumber,
      dateLabel: formatDate(o.refundedAt || o.createdAt, "full"),
      customerLabel: o.customer?.name || labels.walkIn,
      cashierLabel: o.user?.name || "",
      refundedByLabel: o.refundedBy?.name || undefined,
      reasonLabel: o.refundReason || labels.noReason,
      statusLabel: t(`orders.${o.status}`),
      items: o.items.map((it) => ({
        productName: it.productName,
        qtyLabel: lineQtyLabel(it.quantity, it.unit),
        unitPriceLabel: formatCurrencyBase(it.unitPrice),
        totalLabel: formatCurrencyBase(it.total),
      })),
      refundedLabel: formatCurrencyBase(refundedAmount),
      ...(partial ? { totalLabel: formatCurrencyBase(o.total) } : {}),
    };
  });

  printRefundReceipts(receiptOrders, settings, labels);
}

export function printRefundReceipts(
  orders: PrintReceiptOrder[],
  settings: PrintReceiptSettings,
  labels: PrintReceiptLabels
): void {
  const blocks = orders
    .map((o) => {
      const rows = o.items
        .map(
          (it) => `
        <tr>
          <td class="item-name">${esc(it.productName)}</td>
          <td class="right muted">${esc(it.qtyLabel)} × ${esc(it.unitPriceLabel)}</td>
          <td class="right">${esc(it.totalLabel)}</td>
        </tr>`
        )
        .join("");

      return `
      <div class="receipt">
        <div class="receipt-head">
          <p class="store">${esc(settings.storeName || labels.order)}</p>
          ${settings.storeAddress ? `<p>${esc(settings.storeAddress)}</p>` : ""}
          ${settings.storePhone ? `<p>${esc(settings.storePhone)}</p>` : ""}
          ${settings.receiptHeader ? `<p class="muted">${esc(settings.receiptHeader)}</p>` : ""}
        </div>
        <div class="divider"></div>
        <table class="meta">
          <tr><td>${esc(labels.order)}</td><td class="right mono">${esc(o.orderNumber)}</td></tr>
          <tr><td>${esc(labels.date)}</td><td class="right">${esc(o.dateLabel)}</td></tr>
          <tr><td>${esc(labels.customer)}</td><td class="right">${esc(o.customerLabel)}</td></tr>
          <tr><td>${esc(labels.cashier)}</td><td class="right">${esc(o.cashierLabel)}</td></tr>
          ${o.refundedByLabel ? `<tr><td>${esc(labels.refundedBy)}</td><td class="right">${esc(o.refundedByLabel)}</td></tr>` : ""}
          <tr><td>${esc(labels.status)}</td><td class="right">${esc(o.statusLabel)}</td></tr>
        </table>
        <div class="divider"></div>
        <table class="items">
          <thead>
            <tr>
              <th>${esc(labels.items)}</th>
              <th class="right">${esc(labels.refundedAmount)}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="divider"></div>
        ${o.reasonLabel ? `<p class="reason"><strong>${esc(labels.reason)}:</strong> ${esc(o.reasonLabel)}</p>` : ""}
        ${o.totalLabel ? `<p class="total muted">${esc(labels.originalTotal)}: ${esc(o.totalLabel)}</p>` : ""}
        <p class="total refunded">${esc(labels.refundedAmount)}: ${esc(o.refundedLabel)}</p>
        ${settings.receiptFooter ? `<p class="muted footer">${esc(settings.receiptFooter)}</p>` : ""}
      </div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(labels.refundedAmount)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "IBM Plex Sans", "IBM Plex Sans Arabic", -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; background: #fff; }
  .receipt { max-width: 420px; margin: 0 auto; padding: 24px 8px; page-break-after: always; }
  .receipt:last-child { page-break-after: auto; }
  .receipt-head { text-align: center; }
  .receipt-head .store { font-size: 18px; font-weight: 700; letter-spacing: 0.3px; }
  .receipt-head p { font-size: 12px; line-height: 1.5; }
  .muted { color: #555; }
  .divider { border-top: 1px dashed #999; margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 2px 0; vertical-align: top; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; }
  .right { text-align: right; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .item-name { font-weight: 600; }
  .reason { font-size: 12px; margin: 6px 0; }
  .total { font-size: 13px; margin-top: 4px; text-align: right; }
  .total.refunded { font-size: 15px; font-weight: 700; margin-top: 8px; }
  .footer { text-align: center; margin-top: 14px; font-size: 11px; }
  @media print {
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  }
</style>
</head>
<body>${blocks}</body>
</html>`;

  const win = window.open("", "_blank", "width=520,height=720");
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Wait for the document to be laid out before printing
  setTimeout(() => {
    win.focus();
    win.print();
  }, 350);
}