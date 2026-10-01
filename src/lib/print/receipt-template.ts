/* ═══════════════════════════════════════════════════════════════
   RECEIPT TEMPLATE — the ONE source of truth
   One HTML/CSS template drives the on-screen preview, the thermal
   raster (band-by-band) and the PDF archive. The template renders
   ONLY the frozen snapshot (lib/receipt-snapshot): it never reads
   live tables and contains NO arithmetic — every amount arrives
   pre-formatted from the money layer (formatCurrencyBase).

   templateVersion: bump on any LAYOUT change; every past version
   stays renderable (versions/v{n}.ts) so old receipts reprint
   faithfully. v1 is the initial layout.

   Width comes from the printer profile (printable_dots at 96 dpi ⇒
   px = dots / dpi * 96) — the template itself fixes NO width.
   Urdu reaches thermal printers as raster only (the template is
   rendered in the DOM with the bundled Noto Naskh Arabic font,
   then rasterized — never as text-mode bytes).
   ═══════════════════════════════════════════════════════════════ */

import type { ReceiptSnapshot } from "@/lib/receipts/receipt-snapshot";
import { formatCurrencyBase } from "@/lib/utils";
import { lineQtyLabel } from "@/lib/products/units";

/** Current layout version — bump when the template changes. */
export const RECEIPT_TEMPLATE_VERSION = 1;

/**
 * Fonts the receipt template uses (all local, OFL-1.1, zero network).
 * SPEC RULE: Nastaliq is NEVER on the thermal receipt path (rasterizes
 * to mud at receipt sizes and its sweeping ligatures smear on 1-bit
 * band rasterization) — it lives only on A4/A5 report letterheads
 * (print-report.ts). On receipts:
 *   • Latin body — IBM Plex Sans (matches the app UI)
 *   • Urdu body  — Noto Naskh Arabic: the legible workhorse for the
 *     store name and item lines at receipt sizes, regular + bold
 */
export const URDU_FONT_FAMILY = "Noto Naskh Arabic";
export const URDU_FONT_URL = "/fonts/noto-naskh-arabic-arabic-400-normal.woff2";
export const URDU_FONT_BOLD_URL = "/fonts/noto-naskh-arabic-arabic-700-normal.woff2";
export const LATIN_FONT_FAMILY = "IBM Plex Sans";
export const LATIN_FONT_URL = "/fonts/ibm-plex-sans-latin-400-normal.woff2";

/**
 * Urdu-Indic digits (۰-۹) on receipts? Default OFF: Western numerals
 * (0-9) match standard Pakistani retail convention. Read from the
 * optional snapshot flag so a store can opt in without a code change.
 */
export function urduDigitsEnabled(snapshot: { urduDigits?: boolean } | null | undefined): boolean {
  return snapshot?.urduDigits === true;
}

/** Convert Western digits to Urdu-Indic when the store opted in. */
function num(s: string, urduDigits: boolean): string {
  if (!urduDigits) return s;
  const d = "۰۱۲۳۴۵۶۷۸۹";
  return s.replace(/[0-9]/g, (c) => d[Number(c)] ?? c);
}

/** Families/weights the measurement step must preload before
 *  reading heights (Urdu ascenders/descenders change line boxes). */
export const RECEIPT_FONT_PRELOADS: Array<{ family: string; weight: string; text: string }> = [
  { family: URDU_FONT_FAMILY, weight: "400", text: "نئیجار سپر مارٹ رسید کل رقم ادائیگی ٹ ڈ ڑ ژ ک گ" },
  { family: URDU_FONT_FAMILY, weight: "700", text: "کل رقم ٹیوب ویل" },
  { family: LATIN_FONT_FAMILY, weight: "400", text: "Receipt Total 0123456789" },
];

/** The money formatting type all template amounts flow through. */
type Fmt = (cents: number) => string;

export interface TemplateRenderOptions {
  /** CSS pixel width = profile printable_dots mapped to 96dpi px. */
  widthPx: number;
  /** en | ur | bilingual (from the receipt row, not live settings). */
  language?: "en" | "ur" | "bilingual";
  /** Latest fiscal data for reprints (receipt row never changes). */
  fiscal?: { invoiceNo: string; qrPayload?: string | null; fiscalizedAt?: string } | null;
  /** DUPLICATE COPY marker + count (reprints only). */
  duplicate?: { count: number };
  /** Voided receipts keep their number with a VOID banner. */
  voided?: boolean;
}

/** The exact label keys the template reads — typed so a missing
 *  translation is a compile error, not a blank on paper. */
type ReceiptLabels = {
  receipt: string; date: string; cashier: string; terminal: string;
  customer: string; item: string; qty: string; price: string; total: string;
  subtotal: string; discount: string; tax: string; grandTotal: string;
  paid: string; change: string; due: string; loyalty: string;
  loyaltyBalance: string; points: string; fbr: string;
  fiscalPending: string; verify: string; duplicate: string;
  void: string; original: string; thankYou: string;
  returns: string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Row of label/value; direction-safe (values are LTR numerals even in RTL
 * — tabular figures keep money columns aligned regardless of script).
 * Digits route through num() so an opt-in store gets Urdu-Indic numerals.
 */
function row(label: string, value: string, cls = "", urduDigits = false): string {
  return `<div class="r ${cls}"><span class="l">${esc(label)}</span><span class="v">${esc(num(value, urduDigits))}</span></div>`;
}

/**
 * Localized label set. The receipt's frozen snapshot stores the
 * language; labels resolve at render time (labels are chrome, not
 * frozen content).
 */
function labels(lang: "en" | "ur" | "bilingual"): ReceiptLabels {
  const en = {
    receipt: "Receipt", date: "Date", cashier: "Cashier", terminal: "Terminal",
    customer: "Customer", item: "Item", qty: "Qty", price: "Price", total: "Total",
    subtotal: "Subtotal", discount: "Discount", tax: "Tax", grandTotal: "TOTAL",
    paid: "Paid", change: "Change", due: "Due (Credit)", loyalty: "Loyalty",
    loyaltyBalance: "Loyalty balance", points: "pts", fbr: "FBR Invoice",
    fiscalPending: "Fiscalization pending (offline)",
    verify: "Verify at fbr.gov.pk", duplicate: "DUPLICATE COPY",
    void: "VOID", original: "ORIGINAL", thankYou: "Thank you for your purchase!",
    returns: "Returns accepted with this receipt within 14 days.",
  };
  if (lang === "en") return en;
  const ur: ReceiptLabels = {
    ...en,
    receipt: "رسید", date: "تاریخ", cashier: "کیشیر", terminal: "ٹرمینل",
    customer: "گاہک", item: "آئٹم", qty: "مقدار", price: "قیمت", total: "کل",
    subtotal: "ذیلی مجموعہ", discount: "رعایت", tax: "ٹیکس", grandTotal: "کل رقم",
    paid: "ادائیگی", change: "بقیہ", due: "بقایا (ادھار)", loyalty: "لائلٹی",
    loyaltyBalance: "لائلٹی بیلنس", points: "پوائنٹس", fbr: "ایف بی آر انوائس",
    fiscalPending: "فاسکلائزیشن زیرِ التوا (آف لائن)",
    verify: "تصدیق کریں fbr.gov.pk", duplicate: "نقل نقل",
    void: "منسوخ", original: "اصل",
    thankYou: "آپ کی خریداری کا شکریہ!",
    returns: "بازگشت کی سہولت 14 دنوں تک رسید کے ساتھ دستیاب ہے۔",
  };
  if (lang === "ur") return ur;
  return {
    // bilingual: Urdu label followed by English on the same row.
    ...en,
    grandTotal: "کل رقم · TOTAL",
    thankYou: "آپ کی خریداری کا شکریہ · Thank you!",
  };
}

/**
 * Render the receipt body HTML (inner document). Pure — same output
 * drives preview, measurement, raster and tests.
 */
export function renderReceiptBody(
  snapshot: ReceiptSnapshot,
  fmt: Fmt,
  opts: TemplateRenderOptions
): string {
  const lang = opts.language ?? (snapshot.language as "en" | "ur" | "bilingual");
  const t = labels(lang);
  const rtl = lang !== "en";
  const dir = rtl ? 'dir="rtl" lang="ur"' : 'dir="ltr" lang="en"';
  const digits = urduDigitsEnabled(snapshot);

  const lines = snapshot.items
    .map(
      (it) => `
  <div class="line">
    <div class="line-name">${esc(it.productName)}</div>
    <div class="line-row">
      <span class="qty">${esc(num(lineQtyLabel(it.quantity, it.unit), digits))}</span>
      <span class="price">× ${esc(num(fmt(it.unitPrice), digits))}</span>
      <span class="amt">${esc(num(fmt(it.total), digits))}</span>
    </div>
    ${it.discountAmount > 0 ? `<div class="line-disc">${esc(t.discount)} ${esc(num(fmt(it.discountAmount), digits))}</div>` : ""}
  </div>`
    )
    .join("");

  const paymentRows = [
    row(t.paid, fmt(snapshot.paidAmount), "", digits),
    snapshot.dueAmount > 0 ? row(t.due, fmt(snapshot.dueAmount), "due", digits) : "",
    snapshot.changeAmount > 0 ? row(t.change, fmt(snapshot.changeAmount), "change", digits) : "",
  ].join("");

  const fiscalBlock = opts.fiscal
    ? `
  <div class="fiscal">
    ${row(t.fbr, opts.fiscal.invoiceNo, "mono")}
    ${opts.fiscal.qrPayload ? `<div class="qr" data-qr-payload="${esc(opts.fiscal.qrPayload)}"></div>` : ""}
    <div class="fine">${esc(t.verify)}</div>
  </div>`
    : `
  <div class="fiscal">
    <div class="fine">${esc(t.fiscalPending)}</div>
  </div>`;

  return `
<div class="receipt" ${dir} data-template-version="1">
  <div class="head">
    <div class="store">${esc(snapshot.storeName)}</div>
    ${snapshot.storeAddress ? `<div class="fine">${esc(snapshot.storeAddress)}</div>` : ""}
    ${snapshot.storePhone ? `<div class="fine">${esc(snapshot.storePhone)}</div>` : ""}
    ${snapshot.receiptHeader ? `<div class="fine">${esc(snapshot.receiptHeader)}</div>` : ""}
  </div>
  <div class="meta">
    ${row(t.receipt, snapshot.receiptNo, "", digits)}
    ${row(t.date, new Date(snapshot.issuedAt).toLocaleString("en-GB", { hour12: false }), "", digits)}
    ${row(t.cashier, snapshot.cashierName || "—", "", digits)}
    ${row(t.terminal, snapshot.terminalId, "", digits)}
    ${snapshot.customerName ? row(t.customer, snapshot.customerName, "", digits) : ""}
    ${opts.duplicate ? `<div class="dup">${esc(t.duplicate)} · ${num(String(opts.duplicate.count), digits)}</div>` : `<div class="dup">${esc(t.original)}</div>`}
    ${opts.voided ? `<div class="void">${esc(t.void)}</div>` : ""}
  </div>
  <div class="lines">${lines}</div>
  <div class="totals">
    ${row(t.subtotal, fmt(snapshot.subtotal), "", digits)}
    ${snapshot.discountAmount > 0 ? row(t.discount, fmt(snapshot.discountAmount), "", digits) : ""}
    ${snapshot.taxAmount > 0 ? row(t.tax, fmt(snapshot.taxAmount), "", digits) : ""}
    ${snapshot.loyaltyRedeemed > 0 ? row(`${t.loyalty} (${num(String(snapshot.loyaltyPointsRedeemed), digits)} ${t.points})`, fmt(snapshot.loyaltyRedeemed), "", digits) : ""}
    ${row(t.grandTotal, fmt(snapshot.total), "grand", digits)}
    ${snapshot.customerName ? row(t.loyaltyBalance, `${num(String(snapshot.customerLoyaltyBalance), digits)} ${t.points}`, "", digits) : ""}
  </div>
  <div class="payments">${paymentRows}</div>
  ${fiscalBlock}
  <div class="foot">
    ${snapshot.receiptFooter ? `<div class="fine">${esc(snapshot.receiptFooter)}</div>` : ""}
    <div class="fine">${esc(t.returns)}</div>
    <div class="fine center">${esc(t.thankYou)}</div>
  </div>
</div>`;
}

/** Full standalone document (preview + browser print driver). */
export function renderReceiptDocument(
  snapshot: ReceiptSnapshot,
  opts: TemplateRenderOptions
): string {
  const lang = opts.language ?? (snapshot.language as "en" | "ur" | "bilingual");
  const rtl = lang !== "en";
  // One money formatter (existing money layer, base currency — printed
  // legal artifacts never render display-currency conversions).
  const fmt: Fmt = (cents) => formatCurrencyBase(cents);

  return `<!DOCTYPE html>
<html dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8" />
<title>${esc(snapshot.receiptNo)}</title>
<style>
  /* Receipt faces — all local woff2 (OFL-1.1), zero network. Naskh
     carries Urdu body text at receipt sizes; Plex matches the app's
     Latin UI. */
  @font-face {
    font-family: "${URDU_FONT_FAMILY}";
    src: url("${URDU_FONT_URL}") format("woff2");
    font-weight: 400;
    font-display: block;
  }
  @font-face {
    font-family: "${URDU_FONT_FAMILY}";
    src: url("${URDU_FONT_BOLD_URL}") format("woff2");
    font-weight: 700;
    font-display: block;
  }
  @font-face {
    font-family: "${LATIN_FONT_FAMILY}";
    src: url("${LATIN_FONT_URL}") format("woff2");
    font-weight: 400;
    font-display: block;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: ${rtl ? `"${URDU_FONT_FAMILY}", ` : ""}"${LATIN_FONT_FAMILY}", -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    color: #000;
    background: #fff;
    font-size: 12px;
    line-height: 1.5;
  }
  .receipt { width: ${opts.widthPx}px; padding: 4px 2px 6px; }
  .head { text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; }
  .store { font-size: 15px; font-weight: 700; }
  .fine { font-size: 10px; color: #333; }
  .center { text-align: center; }
  .meta, .totals, .payments { border-bottom: 1px dashed #000; padding: 4px 0; }
  .r { display: flex; justify-content: space-between; gap: 8px; }
  /* Every money/qty/total column aligns on tabular figures, whichever
     face resolves — and Latin digits stay LTR inside RTL rows. */
  .r .v { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; white-space: nowrap; }
  .r.mono .v { font-family: ui-monospace, Menlo, monospace; }
  .dup, .void { text-align: center; font-weight: 700; padding: 3px 0 0; font-size: 11px; }
  .void { border: 1px solid #000; margin: 3px 0; }
  .line { padding: 2px 0; }
  .line-name { font-weight: 600; overflow-wrap: anywhere; }
  .line-row { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; }
  .line-row .qty, .line-row .price { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
  .line-row .amt { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .line-disc { font-size: 10px; color: #333; }
  .totals .grand { font-size: 14px; font-weight: 700; }
  .totals .r, .payments .r { padding: 1px 0; }
  .change { color: #060; }
  .due { color: #900; font-weight: 700; }
  .fiscal { border-bottom: 1px dashed #000; padding: 4px 0; text-align: center; }
  .qr { margin: 4px auto; }
  .qr svg, .qr img { display: block; margin: 0 auto; image-rendering: pixelated; }
  .foot { padding-top: 4px; }
  .foot .fine { padding: 1px 0; }
  @media print {
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    @page { size: ${opts.widthPx}px auto; margin: 0; }
  }
</style>
</head>
<body>${renderReceiptBody(snapshot, fmt, opts)}</body>
</html>`;
}
