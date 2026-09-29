import { formatCurrencyBase } from "@/lib/utils";
import { lineQtyLabel } from "@/lib/units";
import QRCode from "qrcode";

/* ═══════════════════════════════════════════════════════════════
   POS RECEIPT PRINTER
   Generates a clean, thermal-printer-friendly receipt for POS
   transactions. Opens a print window with proper formatting.

   v2 upgrades:
   - Async: builds a QR payment SVG (when `settings.receiptQrPayment`
     is set) and inlines it at the foot of the receipt — scannable
     by any wallet app at the counter, no network needed in the popup
   - Order metadata block (order no / date / customer / cashier)
   - Tighter monospace layout with tabular figures
   ═══════════════════════════════════════════════════════════════ */

export interface POSReceiptItem {
  productName: string;
  quantity: number;
  unit?: string | null;
  unitPrice: number;
  total: number;
}

export interface POSReceiptOrder {
  orderNumber: string;
  createdAt: string;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  paymentMethod: string;
  amountPaid: number;
  changeDue: number;
  /** Cents the customer still owes on this order (credit sale). */
  dueAmount?: number;
  /** paid | partial | unpaid. */
  paymentStatus?: string;
  /** Cents discounted via loyalty points (0 when not used). */
  loyaltyRedeemed?: number;
  loyaltyPointsRedeemed?: number;
  user?: { name: string } | null;
  customer?: { name: string; email?: string; outstandingBalance?: number } | null;
  items: POSReceiptItem[];
}

export interface POSReceiptSettings {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  /** QR payment payload printed at the foot of the receipt ("" = off). */
  receiptQrPayment?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Cash",
  credit_card: "Credit Card",
  debit_card: "Debit Card",
  digital_wallet: "Digital Wallet",
  bank_transfer: "Bank Transfer",
  store_credit: "Store Credit",
};

/** Render the QR payment SVG (or "" when disabled / on failure). */
async function buildQrSvg(payload: string): Promise<string> {
  if (!payload || !payload.trim()) return "";
  try {
    // SVG inlines into the print window — no image fetching, prints crisply
    // at thermal resolution (crispEdges keeps modules square on 203dpi heads).
    return await QRCode.toString(payload.trim(), {
      type: "svg",
      margin: 0,
      width: 96,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch {
    return ""; // A QR failure must never block printing the receipt
  }
}

/**
 * Opens a print window with a clean thermal-receipt layout.
 * Async: resolves once the print window has been opened (or skipped when
 * the popup was blocked — the receipt itself never throws).
 */
export async function printPOSReceipt(
  order: POSReceiptOrder,
  settings: POSReceiptSettings,
  opts?: { autoPrint?: boolean }
): Promise<void> {
  const autoPrint = opts?.autoPrint ?? true;

  const dateStr = new Date(order.createdAt).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const paymentLabel = PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod;
  const qrSvg = await buildQrSvg(settings.receiptQrPayment ?? "");

  const itemRows = order.items
    .map(
      (it) => `
      <tr>
        <td class="item-name">${esc(it.productName)}</td>
        <td class="right muted">${esc(lineQtyLabel(it.quantity, it.unit))}</td>
        <td class="right">${esc(formatCurrencyBase(it.total))}</td>
      </tr>
      <tr>
        <td colspan="3" class="item-detail">${esc(lineQtyLabel(it.quantity, it.unit))} × ${esc(formatCurrencyBase(it.unitPrice))}</td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Receipt — ${esc(order.orderNumber)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Courier New", Courier, monospace;
    color: #111;
    background: #fff;
    font-size: 12px;
    line-height: 1.4;
  }
  .receipt {
    max-width: 300px;
    margin: 0 auto;
    padding: 16px 12px;
  }
  .store-header {
    text-align: center;
    margin-bottom: 8px;
    border-bottom: 1px dashed #999;
    padding-bottom: 8px;
  }
  .store-name {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.5px;
  }
  .store-info {
    font-size: 10px;
    color: #555;
    margin-top: 2px;
  }
  .receipt-header {
    text-align: center;
    font-size: 10px;
    color: #666;
    margin-bottom: 8px;
  }
  .order-info {
    font-size: 11px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px dashed #999;
  }
  .order-info .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .order-info .row .label { color: #555; }
  .order-info .row .value { font-variant-numeric: tabular-nums; text-align: right; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  td, th {
    padding: 1px 0;
    vertical-align: top;
  }
  th {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #555;
    text-align: left;
    padding-bottom: 3px;
    border-bottom: 1px solid #ddd;
  }
  .right { text-align: right; }
  .muted { color: #666; }
  .item-name { font-weight: 600; }
  .item-detail { font-size: 10px; color: #888; padding-bottom: 4px; }
  .totals {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed #999;
  }
  .totals .row {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    padding: 1px 0;
    font-variant-numeric: tabular-nums;
  }
  .totals .row.grand-total {
    font-size: 14px;
    font-weight: 700;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid #333;
  }
  .totals .row.discount { color: #16a34a; }
  .payment-info {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed #999;
    font-size: 11px;
  }
  .payment-info .row {
    display: flex;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .change { color: #16a34a; font-weight: 600; }
  .due { color: #b45309; font-weight: 700; }
  .due-note {
    margin-top: 4px;
    font-size: 9px;
    color: #b45309;
    text-align: center;
    border-top: 1px dashed #d9c39a;
    padding-top: 4px;
  }
  .qr-block {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px dashed #999;
    text-align: center;
  }
  .qr-block .qr-img svg { display: block; margin: 0 auto; }
  .qr-block .qr-caption {
    margin-top: 4px;
    font-size: 9px;
    color: #555;
    letter-spacing: 0.3px;
  }
  .footer {
    margin-top: 10px;
    padding-top: 6px;
    border-top: 1px dashed #999;
    text-align: center;
    font-size: 10px;
    color: #666;
  }
  .footer p { margin-top: 2px; }
  @media print {
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="receipt">
    <div class="store-header">
      <div class="store-name">${esc(settings.storeName || "Store")}</div>
      ${settings.storeAddress ? `<div class="store-info">${esc(settings.storeAddress)}</div>` : ""}
      ${settings.storePhone ? `<div class="store-info">${esc(settings.storePhone)}</div>` : ""}
    </div>
    ${settings.receiptHeader ? `<div class="receipt-header">${esc(settings.receiptHeader)}</div>` : ""}

    <div class="order-info">
      <div class="row"><span class="label">Order</span><span class="value">${esc(order.orderNumber)}</span></div>
      <div class="row"><span class="label">Date</span><span class="value">${esc(dateStr)}</span></div>
      ${order.customer?.name ? `<div class="row"><span class="label">Customer</span><span class="value">${esc(order.customer.name)}</span></div>` : ""}
      ${order.user?.name ? `<div class="row"><span class="label">Cashier</span><span class="value">${esc(order.user.name)}</span></div>` : ""}
    </div>

    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th class="right">Qty</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${esc(formatCurrencyBase(order.subtotal))}</span></div>
      ${order.discountAmount > 0 ? `<div class="row discount"><span>Discount</span><span>-${esc(formatCurrencyBase(order.discountAmount))}</span></div>` : ""}
      ${order.loyaltyRedeemed && order.loyaltyRedeemed > 0 ? `<div class="row discount"><span>Loyalty (${esc(String(order.loyaltyPointsRedeemed ?? 0))} pts)</span><span>-${esc(formatCurrencyBase(order.loyaltyRedeemed))}</span></div>` : ""}
      ${order.taxAmount > 0 ? `<div class="row"><span>Tax</span><span>${esc(formatCurrencyBase(order.taxAmount))}</span></div>` : ""}
      <div class="row grand-total"><span>TOTAL</span><span>${esc(formatCurrencyBase(order.total))}</span></div>
    </div>

    <div class="payment-info">
      <div class="row"><span>Payment</span><span>${esc(paymentLabel)}</span></div>
      ${order.amountPaid > 0 ? `<div class="row"><span>Paid</span><span>${esc(formatCurrencyBase(order.amountPaid))}</span></div>` : ""}
      ${order.dueAmount && order.dueAmount > 0 ? `<div class="row due"><span>Due (Credit)</span><span>${esc(formatCurrencyBase(order.dueAmount))}</span></div>` : ""}
      ${order.changeDue > 0 ? `<div class="row change"><span>Change</span><span>${esc(formatCurrencyBase(order.changeDue))}</span></div>` : ""}
    </div>
    ${order.dueAmount && order.dueAmount > 0 ? `<div class="due-note">${esc(order.customer?.name ?? "Customer")} owes ${esc(formatCurrencyBase((order.customer?.outstandingBalance ?? 0) > 0 ? order.customer!.outstandingBalance! : order.dueAmount))} total</div>` : ""}

    ${qrSvg ? `
    <div class="qr-block">
      <div class="qr-img">${qrSvg}</div>
      <div class="qr-caption">Scan to pay</div>
    </div>` : ""}

    ${settings.receiptFooter ? `<div class="footer"><p>${esc(settings.receiptFooter)}</p></div>` : ""}
    <div class="footer">
      <p>Thank you for your purchase!</p>
      <p>${esc(settings.storeName || "")}</p>
    </div>
  </div>
</body>
</html>`;

  const win = window.open("", "_blank", "width=400,height=600");
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();

  if (autoPrint) {
    // Wait for layout before printing
    setTimeout(() => {
      win.focus();
      win.print();
    }, 350);
  }
}
