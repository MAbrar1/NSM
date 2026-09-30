import { formatCurrencyBase } from "@/lib/utils";
import { PRINT_BRAND, PRINT_DARK, printCssVars, PRINT_SCHEME_SCRIPT, PAGE_MEASURE_SCRIPT, PRINT_RULER_CSS } from "@/lib/print/print-brand";

/* ═══════════════════════════════════════════════════════════════
   PURCHASE ORDER PRINTER
   Professional A4 PO document: letterhead, supplier block, line
   items, financial totals and sign-off — the printable counterpart
   of the Purchase Orders page.
   ═══════════════════════════════════════════════════════════════ */

export interface POPrintItem {
  productName: string;
  sku?: string | null;
  quantity: number;
  unit?: string | null;
  unitCost: number; // cents
  lineTotal: number; // cents
  receivedQty?: number | null;
}

export interface POPrintData {
  poNumber: string;
  status: string;
  orderDate: string;
  expectedDate?: string | null;
  supplier: { name: string; phone?: string | null; email?: string | null; address?: string | null };
  createdBy?: string | null;
  notes?: string | null;
  items: POPrintItem[];
  /** Set when the PO has a non-zero amount paid (advance/partial). */
  amountPaid?: number | null;
}

export interface POPrintSettings {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  storeEmail?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the complete standalone HTML for a professional A4 PO document —
 * pure (no DOM), so it can also be used for previews and tests.
 * `printPurchaseOrder` wraps this with the print-window plumbing.
 */
export function buildPurchaseOrderHtml(
  data: POPrintData,
  settings: POPrintSettings,
  opts?: { rtl?: boolean; generatedAt?: Date }
): string {
  return poHtml(data, settings, opts);
}

function poHtml(
  data: POPrintData,
  settings: POPrintSettings,
  opts?: { rtl?: boolean; generatedAt?: Date }
): string {
  const rtl = opts?.rtl ?? false;
  const dir = rtl ? 'dir="rtl" lang="ur"' : 'dir="ltr" lang="en"';
  const generatedAt = opts?.generatedAt ?? new Date();
  const generated = generatedAt.toLocaleString(rtl ? "ur-PK" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const statusLabels: Record<string, string> = rtl
    ? { draft: "مسودہ", pending: "زیرِ التوا", ordered: "آرڈر کیا گیا", partial: "جزوی وصول", received: "وصول شدہ", cancelled: "منسوخ" }
    : { draft: "Draft", pending: "Pending", ordered: "Ordered", partial: "Partially Received", received: "Received", cancelled: "Cancelled" };
  const statusLabel = statusLabels[data.status] ?? data.status;

  const contactBits = [settings.storeAddress, settings.storePhone, settings.storeEmail]
    .filter(Boolean)
    .map((b) => esc(b as string))
    .join('<span class="dot">•</span>');

  const itemRows = data.items
    .map((it, i) => {
      return `
      <tr class="${i % 2 ? "alt" : ""}">
        <td class="center num">${i + 1}</td>
        <td>
          <div class="item-name">${esc(it.productName)}</div>
          ${it.sku ? `<div class="muted sku">${esc(it.sku)}</div>` : ""}
        </td>
        <td class="right num">${esc(String(it.quantity))}${it.unit ? ` ${esc(it.unit)}` : ""}</td>
        <td class="right num">${esc(formatCurrencyBase(it.unitCost))}</td>
        <td class="right num strong">${esc(formatCurrencyBase(it.lineTotal))}</td>
      </tr>`;
    })
    .join("");

  const subtotal = data.items.reduce((s, it) => s + it.lineTotal, 0);
  const paid = data.amountPaid ?? 0;
  const due = Math.max(0, subtotal - paid);

  const html = `<!DOCTYPE html>
<html ${dir}>
<head>
<meta charset="utf-8" />
${PRINT_SCHEME_SCRIPT}
<title>PO ${esc(data.poNumber)}</title>
<style>
  :root {
    ${printCssVars("light")}
    --zebra: ${PRINT_BRAND.zebra};
  }
  /* Dark preview (on-screen only — @media print below forces light). */
  [data-scheme="dark"] {
    ${printCssVars("dark")}
    --zebra: ${PRINT_DARK.zebra};
  }
  /* "System" scheme: follow the OS prefers-color-scheme setting. */
  @media (prefers-color-scheme: dark) {
    [data-scheme="auto"] {
      ${printCssVars("dark")}
      --zebra: ${PRINT_DARK.zebra};
    }
  }
  /* PO faces — bundled, OFL-1.1, same origin as the app. Same set as the
     report renderer: Plex for Latin, Plex Arabic + Naskh for Urdu. No
     unresolved font names, no OS roulette. */
  @font-face {
    font-family: "IBM Plex Sans";
    src: url("/fonts/ibm-plex-sans-latin-400-normal.woff2") format("woff2");
    font-weight: 400;
    font-display: block;
  }
  @font-face {
    font-family: "IBM Plex Sans";
    src: url("/fonts/ibm-plex-sans-latin-700-normal.woff2") format("woff2");
    font-weight: 700;
    font-display: block;
  }
  @font-face {
    font-family: "IBM Plex Sans Arabic";
    src: url("/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2") format("woff2");
    font-weight: 400;
    font-display: block;
  }
  @font-face {
    font-family: "IBM Plex Sans Arabic";
    src: url("/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2") format("woff2");
    font-weight: 700;
    font-display: block;
  }
  @font-face {
    font-family: "Noto Naskh Arabic";
    src: url("/fonts/noto-naskh-arabic-arabic-400-normal.woff2") format("woff2");
    font-weight: 400;
    font-display: block;
  }
  @font-face {
    font-family: "Noto Naskh Arabic";
    src: url("/fonts/noto-naskh-arabic-arabic-700-normal.woff2") format("woff2");
    font-weight: 700;
    font-display: block;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--sheet); }
  body {
    font-family: ${rtl
      ? `"IBM Plex Sans Arabic", "Noto Naskh Arabic", `
      : ""}"IBM Plex Sans", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    font-size: 11px;
    line-height: 1.45;
  }
  .num { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: embed; }
  .right { text-align: right; }
  .center { text-align: center; }
  .muted { color: var(--muted); }
  .strong { font-weight: 700; }
  .sheet { max-width: 100%; padding: 0 2mm; }

  .letterhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .letterhead.rtl { flex-direction: row-reverse; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand.rtl { flex-direction: row-reverse; }
  .brand-mark {
    width: 38px; height: 38px; border-radius: 10px;
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: #fff; font-size: 18px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .brand-name { font-size: 16px; font-weight: 700; }
  .brand-contact { font-size: 9px; color: var(--muted); margin-top: 1px; }
  .brand-contact .dot { margin: 0 5px; color: var(--muted); }
  .doc-ref { text-align: right; font-size: 9px; color: var(--muted); }
  .doc-ref .ref { font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; }
  .letterhead.rtl .doc-ref { text-align: left; }

  .title-band {
    margin-top: 10px; background: var(--band);
    border-inline-start: 4px solid var(--brand);
    border-radius: 6px; padding: 10px 14px;
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
  }
  .title-band.rtl { border-inline-start: none; border-inline-end: 4px solid var(--brand); }
  .title-kicker { font-size: 8.5px; letter-spacing: 1.6px; text-transform: uppercase; color: var(--brand); font-weight: 700; }
  .doc-title { font-size: 17px; font-weight: 700; margin-top: 1px; }
  .doc-period { font-size: 10px; color: var(--muted); margin-top: 2px; }
  .chip {
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    background: var(--brand); color: #fff; font-size: 9px; font-weight: 700;
    letter-spacing: 0.8px; text-transform: uppercase; white-space: nowrap;
  }

  .cols { display: flex; gap: 10px; margin-top: 12px; }
  .meta-box { flex: 1; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .meta-box h3 { font-size: 8.5px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--brand-dark); margin-bottom: 6px; }
  .meta-row { display: flex; justify-content: space-between; gap: 10px; font-size: 10.5px; padding: 2px 0; }
  .meta-row > span:first-child { color: var(--muted); }

  table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-top: 14px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th {
    background: var(--band); color: var(--head-text);
    font-size: 8.5px; letter-spacing: 0.9px; text-transform: uppercase;
    text-align: left; padding: 6px 8px;
    border-top: 2px solid var(--brand);
    border-bottom: 1px solid var(--line);
  }
  td { padding: 5.5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr.alt { background: var(--zebra, #f8fafc); }
  .item-name { font-weight: 600; }
  .sku { font-size: 9px; }
  tfoot td {
    background: var(--totals-bg); color: #fff; font-weight: 700;
    border: none; padding: 7px 8px; font-variant-numeric: tabular-nums;
  }
  .footnote { margin-top: 12px; font-size: 10px; color: var(--ink); background: var(--band); border-radius: 6px; padding: 8px 10px; }

  .signatures { margin-top: 34px; display: flex; justify-content: space-between; gap: 40px; }
  .signatures.rtl { flex-direction: row-reverse; }
  .sig { flex: 1; max-width: 240px; text-align: center; }
  .sig .line { border-top: 1px solid var(--muted); margin-top: 30px; padding-top: 4px; font-size: 9px; color: var(--muted); }

  .doc-footer {
    margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--line);
    display: flex; justify-content: space-between; font-size: 8.5px; color: var(--muted);
  }
  .doc-footer .gen { font-variant-numeric: tabular-nums; }

  @page { size: A4; margin: 12mm 10mm; }
  @media print {
    /* Paper is always light, even when the user previews in dark mode. */
    :root, [data-scheme="dark"], [data-scheme="auto"] {
      ${printCssVars("light")}
      --zebra: ${PRINT_BRAND.zebra};
    }
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .sheet { padding: 0; }
  }
  @media screen {
    body { background: var(--page); padding: 20px 0; }
    .sheet { max-width: 800px; margin: 0 auto; background: var(--sheet); padding: 24px 28px; border-radius: 10px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12); }
    [data-scheme="dark"] .sheet { box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
  }
  ${PRINT_RULER_CSS}
</head>
<body>
  <div class="sheet">
    <div class="letterhead${rtl ? " rtl" : ""}">
      <div class="brand${rtl ? " rtl" : ""}">
        <div class="brand-mark">${esc((settings.storeName || "S").trim().charAt(0).toUpperCase())}</div>
        <div>
          <div class="brand-name">${esc(settings.storeName)}</div>
          ${contactBits ? `<div class="brand-contact">${contactBits}</div>` : ""}
        </div>
      </div>
      <div class="doc-ref">
        <div><span>${rtl ? "حوالہ" : "Ref"}</span> <span class="ref">${esc(data.poNumber)}</span></div>
        <div>${esc(generated)}</div>
      </div>
    </div>

    <div class="title-band${rtl ? " rtl" : ""}">
      <div>
        <div class="title-kicker">${rtl ? "خریداری کا آرڈر" : "PURCHASE ORDER"}</div>
        <div class="doc-title">${esc(data.poNumber)}</div>
        <div class="doc-period">${rtl ? "تاریخ:" : "Ordered:"} ${esc(data.orderDate)}</div>
      </div>
      <div class="stamp"><span class="chip">${esc(statusLabel)}</span></div>
    </div>

    <div class="cols">
      <div class="meta-box">
        <h3>${rtl ? "سپلائر" : "SUPPLIER"}</h3>
        <div class="meta-row"><span>${rtl ? "نام" : "Name"}</span><span>${esc(data.supplier.name)}</span></div>
        ${data.supplier.phone ? `<div class="meta-row"><span>${rtl ? "فون" : "Phone"}</span><span class="num">${esc(data.supplier.phone)}</span></div>` : ""}
        ${data.supplier.email ? `<div class="meta-row"><span>${rtl ? "ای میل" : "Email"}</span><span>${esc(data.supplier.email)}</span></div>` : ""}
        ${data.supplier.address ? `<div class="meta-row"><span>${rtl ? "پتہ" : "Address"}</span><span>${esc(data.supplier.address)}</span></div>` : ""}
      </div>
      <div class="meta-box">
        <h3>${rtl ? "آرڈر کی تفصیل" : "ORDER DETAILS"}</h3>
        <div class="meta-row"><span>${rtl ? "PO نمبر" : "PO Number"}</span><span class="num">${esc(data.poNumber)}</span></div>
        ${data.expectedDate ? `<div class="meta-row"><span>${rtl ? "متوقع تاریخ" : "Expected"}</span><span>${esc(data.expectedDate)}</span></div>` : ""}
        ${data.createdBy ? `<div class="meta-row"><span>${rtl ? "تیار کردہ" : "Created by"}</span><span>${esc(data.createdBy)}</span></div>` : ""}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="center">${rtl ? "#" : "#"}</th>
          <th>${rtl ? "پروڈکٹ" : "Item"}</th>
          <th class="right">${rtl ? "مقدار" : "Qty"}</th>
          <th class="right">${rtl ? "لاگت" : "Unit Cost"}</th>
          <th class="right">${rtl ? "کل" : "Line Total"}</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr><td colspan="3"></td><td>${rtl ? "ذیلی کل" : "Subtotal"}</td><td class="right num">${esc(formatCurrencyBase(subtotal))}</td></tr>
        ${paid > 0 ? `<tr><td colspan="3"></td><td>${rtl ? "ادا شدہ" : "Paid"}</td><td class="right num">${esc(formatCurrencyBase(paid))}</td></tr>` : ""}
        ${due > 0 ? `<tr><td colspan="3"></td><td>${rtl ? "بقایا" : "Due"}</td><td class="right num">${esc(formatCurrencyBase(due))}</td></tr>` : ""}
      </tfoot>
    </table>

    ${data.notes ? `<div class="footnote"><strong>${rtl ? "نوٹس:" : "Notes:"}</strong> ${esc(data.notes)}</div>` : ""}

    <div class="signatures${rtl ? " rtl" : ""}">
      <div class="sig"><div class="line">${rtl ? "مجاز دستخط" : "Authorized signature"}</div></div>
      <div class="sig"><div class="line">${rtl ? "سپلائر دستخط" : "Supplier acceptance"}</div></div>
    </div>

    <div class="doc-footer">
      <span>${esc(settings.storeName)}</span>
      <span class="gen">${esc(generated)}</span>
    </div>
  </div>
  ${PAGE_MEASURE_SCRIPT}
</body>
</html>`;

  return html;
}

/**
 * In-app preview of the PO document (global PrintPreview modal).
 * Client-side only (dynamically imported).
 */
export async function previewPurchaseOrder(
  data: POPrintData,
  settings: POPrintSettings,
  opts?: { rtl?: boolean; filename?: string }
): Promise<void> {
  const html = buildPurchaseOrderHtml(data, settings, { rtl: opts?.rtl });
  const { openPrintPreview } = await import("@/components/print/print-preview");
  openPrintPreview(html, opts?.filename ?? "purchase-order");
}

/**
 * Open a print window with the professional A4 PO document.
 * Never throws — a blocked popup is surfaced via the callback.
 */
export function printPurchaseOrder(
  data: POPrintData,
  settings: POPrintSettings,
  opts?: { rtl?: boolean; onBlocked?: () => void }
): void {
  const html = buildPurchaseOrderHtml(data, settings, { rtl: opts?.rtl });
  const win = window.open("", "_blank", "width=880,height=1000");
  if (!win) {
    opts?.onBlocked?.();
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  setTimeout(() => {
    win.focus();
    win.print();
  }, 350);
}
