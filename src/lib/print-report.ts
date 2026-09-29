import { formatCurrencyBase } from "@/lib/utils";
import { PRINT_BRAND, PRINT_DARK, printCssVars, PRINT_SCHEME_SCRIPT, PAGE_MEASURE_SCRIPT, PRINT_RULER_CSS } from "@/lib/print-brand";

/* ═══════════════════════════════════════════════════════════════
   REPORT PRINT ENGINE — one elite A4 document printer shared by
   every page (orders ledger, inventory valuation, refunds, sales,
   customers, suppliers …).

   Design goals:
   - Letterhead: brand mark + store identity + document title band
   - KPI cards: print-safe tinted stat cards above the table
   - Tables: zebra rows, right-aligned tabular numerals, repeating
     <thead> on every printed page, rows never split across pages
   - Totals: a bold totals band under each section
   - RTL: full dir="rtl" mirroring for Urdu
   - Self-contained: styles inlined, prints identically everywhere
   ═══════════════════════════════════════════════════════════════ */

export type PrintAlign = "left" | "right" | "center";
export type PrintTone = "default" | "positive" | "negative" | "warning";

export interface PrintColumn<T> {
  label: string;
  align?: PrintAlign;
  /** Suggested CSS width (e.g. "18%", "90px"); columns flex otherwise. */
  width?: string;
  value: (row: T) => string;
  /** Bold the cell (row headers, grand numbers). */
  strong?: boolean;
  /** Muted secondary text (SKUs, notes). */
  muted?: boolean;
  /** Force a numeric style — keeps numerals tabular + LTR inside RTL. */
  numeric?: boolean;
  /** Compute the totals-row cell for this column (omit → blank). */
  total?: (rows: T[]) => string;
}

export interface PrintSection<T> {
  /** Optional section heading above the table. */
  title?: string;
  columns: PrintColumn<T>[];
  rows: T[];
  /** Label for the totals row (default none). */
  totalsLabel?: string;
  /** Hide the whole section when there are no rows (default true). */
  omitEmpty?: boolean;
  emptyMessage?: string;
}

export interface PrintKpi {
  label: string;
  value: string;
  tone?: PrintTone;
  hint?: string;
}

export interface PrintMetaRow {
  label: string;
  value: string;
}

export interface ReportSettings {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  storeEmail?: string;
}

export interface ReportDoc<T = unknown> {
  /** Document title, e.g. "Inventory Valuation". */
  title: string;
  /** Small kicker above the title, e.g. "Stock Report". */
  kicker?: string;
  /** Human period, e.g. "Jan 1 – Sep 23, 2026". */
  periodLabel?: string;
  /** Reference / document number shown in the title band. */
  reference?: string;
  meta?: PrintMetaRow[];
  kpis?: PrintKpi[];
  /** Single-table shortcut — equivalent to one section. */
  columns?: PrintColumn<T>[];
  rows?: T[];
  totalsLabel?: string;
  /** Multi-section documents (sales report: products/categories/
   *  payments) intentionally mix row shapes per section, so this one
   *  property is typed with `any`: TypeScript cannot infer a per-element
   *  generic from an array literal, and a fixed parameter type would
   *  either reject caller-typed `value(row)` callbacks or break the
   *  inline `total(rows)` arrows. Each call site still fully types its
   *  own columns and rows; the renderer only passes rows back to those
   *  caller-supplied callbacks. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sections?: PrintSection<any>[];
  footnote?: string;
  /** Sign-off block for documents that need it. */
  signature?: { left?: string; right?: string };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fetch store settings for the letterhead (falls back to defaults). */
export async function fetchReportSettings(fallbackName = "Store"): Promise<ReportSettings> {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    const s = (data.settings ?? {}) as Record<string, string | undefined>;
    return {
      storeName: s["storeName"] || fallbackName,
      storeAddress: s["storeAddress"] || undefined,
      storePhone: s["storePhone"] || undefined,
      storeEmail: s["storeEmail"] || undefined,
    };
  } catch {
    return { storeName: fallbackName };
  }
}

/* ── fragment builders ─────────────────────────────────────────── */

function kpiCards(kpis: PrintKpi[], rtl: boolean): string {
  if (!kpis.length) return "";
  const toneVar: Record<PrintTone, string> = {
    default: "var(--ink)",
    positive: PRINT_BRAND.positive,
    negative: PRINT_BRAND.negative,
    warning: PRINT_BRAND.warning,
  };
  const cards = kpis
    .map(
      (k) => `
      <div class="kpi">
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-value" style="color:${toneVar[k.tone ?? "default"]}">${esc(k.value)}</div>
        ${k.hint ? `<div class="kpi-hint">${esc(k.hint)}</div>` : ""}
      </div>`
    )
    .join("");
  return `<div class="kpi-grid${rtl ? " rtl" : ""}">${cards}</div>`;
}

function metaTable(meta: PrintMetaRow[], rtl: boolean): string {
  if (!meta.length) return "";
  const rows = meta
    .map(
      (m) =>
        `<tr><td class="meta-label">${esc(m.label)}</td><td class="meta-value">${esc(m.value)}</td></tr>`
    )
    .join("");
  return `<div class="meta-box${rtl ? " rtl" : ""}"><table>${rows}</table></div>`;
}

function tableHtml<T>(section: PrintSection<T>, rtl: boolean): string {
  const { columns, rows } = section;
  const hasTotals = section.totalsLabel != null && rows.length > 0;

  const colgroup = columns
    .map((c) => `<col${c.width ? ` style="width:${esc(c.width)}"` : ""}/>`)
    .join("");

  const head = columns
    .map(
      (c) =>
        `<th class="${c.align ?? "left"}${rtl ? " flip" : ""}">${esc(c.label)}</th>`
    )
    .join("");

  const body = rows.length
    ? rows
        .map(
          (row, i) =>
            `<tr class="${i % 2 ? "alt" : ""}">${columns
              .map((c) => {
                const cls = [
                  c.align ?? "left",
                  c.strong ? "strong" : "",
                  c.muted ? "muted" : "",
                  c.numeric ? "num" : "",
                  c.align === "right" && rtl ? "flip" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return `<td class="${cls}">${esc(c.value(row))}</td>`;
              })
              .join("")}</tr>`
        )
        .join("")
    : `<tr><td class="empty" colspan="${columns.length}">${esc(section.emptyMessage ?? "—")}</td></tr>`;

  const foot = hasTotals
    ? `<tfoot><tr>${columns
        .map((c, i) => {
          const isLabel = i === 0;
          const text = isLabel
            ? (section.totalsLabel ?? "")
            : c.total
              ? c.total(rows)
              : "";
          const cls = [
            c.align ?? "left",
            isLabel ? "strong" : "",
            c.strong ? "strong" : "",
            c.numeric ? "num" : "",
            c.align === "right" && rtl ? "flip" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `<td class="${cls}">${esc(text)}</td>`;
        })
        .join("")}</tr></tfoot>`
    : "";

  return `<table><colgroup>${colgroup}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

function sectionsHtml<T>(doc: ReportDoc<T>, rtl: boolean): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see ReportDoc.sections
  const sections: PrintSection<any>[] =
    doc.sections ?? [
      {
        columns: doc.columns ?? [],
        rows: doc.rows ?? [],
        totalsLabel: doc.totalsLabel,
      },
    ];
  return sections
    .filter((s) => !(s.omitEmpty !== false && s.rows.length === 0 && s.totalsLabel == null))
    .map(
      (s) => `
      <section class="report-section">
        ${s.title ? `<h2 class="section-title">${esc(s.title)}</h2>` : ""}
        ${tableHtml(s, rtl)}
      </section>`
    )
    .join(`<div class="section-gap"></div>`);
}

/* ── the document ──────────────────────────────────────────────── */

function reportHtml<T>(
  doc: ReportDoc<T>,
  settings: ReportSettings,
  opts: { rtl?: boolean; generatedAt?: Date; paper?: "A4" | "A5"; pageNumbers?: boolean } = {}
): string {
  const rtl = opts.rtl ?? false;
  const dir = rtl ? 'dir="rtl" lang="ur"' : 'dir="ltr" lang="en"';
  const generatedAt = opts.generatedAt ?? new Date();
  const generated = generatedAt.toLocaleString(rtl ? "ur-PK" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const initial = (settings.storeName || "S").trim().charAt(0).toUpperCase();
  const contactBits = [settings.storeAddress, settings.storePhone, settings.storeEmail]
    .filter(Boolean)
    .map((b) => esc(b as string))
    .join('<span class="dot">•</span>');

  return `<!DOCTYPE html>
<html ${dir}>
<head>
<meta charset="utf-8" />
${PRINT_SCHEME_SCRIPT}
<title>${esc(doc.title)}</title>
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
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--sheet); }
  body {
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, "Noto Nastaliq Urdu", sans-serif;
    color: var(--ink);
    font-size: 11px;
    line-height: 1.45;
  }
  .num { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: embed; }
  .sheet { max-width: 100%; padding: 0 2mm; }

  /* ── letterhead ── */
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
  .brand-name { font-size: 16px; font-weight: 700; letter-spacing: 0.2px; }
  .brand-contact { font-size: 9px; color: var(--muted); margin-top: 1px; }
  .brand-contact .dot { margin: 0 5px; color: var(--muted); }
  .doc-ref { text-align: right; font-size: 9px; color: var(--muted); }
  .doc-ref .ref { font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; }

  /* ── title band ── */
  .title-band {
    margin-top: 10px; background: var(--band);
    border-inline-start: 4px solid var(--brand);
    border-radius: 6px; padding: 10px 14px;
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
  }
  .title-band.rtl { border-inline-start: none; border-inline-end: 4px solid var(--brand); }
  .title-kicker { font-size: 8.5px; letter-spacing: 1.6px; text-transform: uppercase; color: var(--brand); font-weight: 700; }
  .doc-title { font-size: 17px; font-weight: 700; letter-spacing: 0.2px; margin-top: 1px; }
  .doc-period { font-size: 10px; color: var(--muted); margin-top: 2px; }
  .title-band .stamp { text-align: right; font-size: 9px; color: var(--muted); white-space: nowrap; }
  .title-band.rtl .stamp { text-align: left; }

  /* ── KPI cards ── */
  .kpi-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .kpi {
    flex: 1 1 130px; min-width: 120px;
    border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; background: var(--sheet);
  }
  .kpi-label { font-size: 8px; letter-spacing: 1.1px; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .kpi-value { font-size: 15px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .kpi-hint { font-size: 8.5px; color: var(--muted); margin-top: 1px; }

  /* ── meta box ── */
  .meta-box { margin-top: 10px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .meta-box table { width: 100%; border-collapse: collapse; font-size: 10px; }
  .meta-box td { padding: 5px 10px; border-top: 1px solid var(--line); }
  .meta-box tr:first-child td { border-top: none; }
  .meta-box .meta-label { color: var(--muted); width: 1%; white-space: nowrap; font-weight: 600; }
  .meta-box .meta-value { font-variant-numeric: tabular-nums; }

  /* ── sections + tables ── */
  .section-gap { height: 14px; }
  .report-section { margin-top: 14px; }
  .section-title {
    font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase;
    color: var(--brand-dark); font-weight: 700; margin-bottom: 6px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th {
    background: var(--band); color: var(--head-text);
    font-size: 8.5px; letter-spacing: 0.9px; text-transform: uppercase;
    text-align: left; padding: 6px 8px;
    border-top: 2px solid var(--brand);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  th.right, td.right { text-align: right; }
  th.center, td.center { text-align: center; }
  th.flip, td.flip { text-align: left; }
  th:first-child { border-start-start-radius: 6px; }
  th:last-child { border-start-end-radius: 6px; }
  td { padding: 5.5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr.alt { background: var(--zebra); }
  td.strong { font-weight: 700; }
  td.muted { color: var(--muted); }
  td.empty { text-align: center; color: var(--muted); padding: 14px; }
  tfoot td {
    background: var(--totals-bg); color: #fff; font-weight: 700;
    border: none; padding: 7px 8px; font-variant-numeric: tabular-nums;
    font-size: 10.5px;
  }
  tfoot td:first-child { border-start-start-radius: 0; }

  /* ── footnote + signature + footer ── */
  .footnote { margin-top: 10px; font-size: 9px; color: var(--muted); }
  .signatures { margin-top: 28px; display: flex; justify-content: space-between; gap: 40px; }
  .signatures.rtl { flex-direction: row-reverse; }
  .sig { flex: 1; max-width: 240px; text-align: center; }
  .sig .line { border-top: 1px solid var(--muted); margin-top: 30px; padding-top: 4px; font-size: 9px; color: var(--muted); }
  .doc-footer {
    margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--line);
    display: flex; justify-content: space-between; font-size: 8.5px; color: var(--muted);
  }
  .doc-footer .gen { font-variant-numeric: tabular-nums; }

  /* A4 default; A5 halves the sheet (callsites pick per report).
     thead { display: table-header-group } + tr { page-break-inside:
     avoid } above repeat the table header and keep rows whole. */
  @page { size: ${opts.paper ?? "A4"}; margin: 12mm 10mm; }
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
</style>
</head>
<body>
  <div class="sheet">
    <div class="letterhead${rtl ? " rtl" : ""}">
      <div class="brand${rtl ? " rtl" : ""}">
        <div class="brand-mark">${esc(initial)}</div>
        <div>
          <div class="brand-name">${esc(settings.storeName)}</div>
          ${contactBits ? `<div class="brand-contact">${contactBits}</div>` : ""}
        </div>
      </div>
      <div class="doc-ref">
        ${doc.reference ? `<div><span>${rtl ? "حوالہ" : "Ref"}</span> <span class="ref">${esc(doc.reference)}</span></div>` : ""}
        <div>${esc(generated)}</div>
      </div>
    </div>

    <div class="title-band${rtl ? " rtl" : ""}">
      <div>
        ${doc.kicker ? `<div class="title-kicker">${esc(doc.kicker)}</div>` : ""}
        <div class="doc-title">${esc(doc.title)}</div>
        ${doc.periodLabel ? `<div class="doc-period">${esc(doc.periodLabel)}</div>` : ""}
      </div>
    </div>

    ${kpiCards(doc.kpis ?? [], rtl)}
    ${metaTable(doc.meta ?? [], rtl)}
    ${sectionsHtml(doc, rtl)}

    ${doc.footnote ? `<div class="footnote">${esc(doc.footnote)}</div>` : ""}
    ${
      doc.signature
        ? `<div class="signatures${rtl ? " rtl" : ""}">
      ${doc.signature.left ? `<div class="sig"><div class="line">${esc(doc.signature.left)}</div></div>` : ""}
      ${doc.signature.right ? `<div class="sig"><div class="line">${esc(doc.signature.right)}</div></div>` : ""}
    </div>`
        : ""
    }

    <div class="doc-footer">
      <span>${esc(settings.storeName)}${rtl ? " — " : " — "}${rtl ? "دستاویز" : "Document"}</span>
      <span class="gen">${esc(generated)}${opts.pageNumbers ? ' · <span class="page-of" data-page-of="1">Page 1</span>' : ""}</span>
    </div>
  </div>
  ${opts.pageNumbers ? PAGE_NUMBER_SCRIPT : ""}
  ${PAGE_MEASURE_SCRIPT}
</body>
</html>`;
}

/**
 * Footer page numbers. @page margin-boxes (@bottom-center content:
 * counter(page)) are NOT reliably supported in Chromium/WebKitGTK
 * print paths, so the preview and printed footer carry a JS-injected
 * "Page X of Y" that counts laid-out A4/A5 sheets the same way the
 * page-break ruler does (same usable-height math). The static footer
 * remains legible when JS is off — it just shows no number.
 */
export const PAGE_NUMBER_SCRIPT =
  `<script>(function(){var MM_PER_PX=25.4/96;function usablePx(){var a4=297-24;if(a4===0)return 0;var pageMM=(document.documentElement.getAttribute("data-paper")==="a5")?210-24:297-24;return (1/MM_PER_PX)*pageMM;}` +
  `function pages(){var el=document.querySelector(".sheet");if(!el)return 1;return Math.max(1,Math.ceil(el.scrollHeight/usablePx()));}` +
  `function update(){var n=pages();var el=document.querySelector("[data-page-of]");if(el)el.textContent=(document.documentElement.dir==="rtl"?"صفحة 1 من "+n:"Page 1 of "+n);}` +
  `if(document.readyState!=="loading"){update();}else{document.addEventListener("DOMContentLoaded",update);}` +
  `window.addEventListener("load",update);})();</script>`;

export interface PrintReportOptions<T> {
  /** Force RTL layout (defaults to the app's document direction). */
  rtl?: boolean;
  settings?: ReportSettings;
  /** Window title override. */
  windowTitle?: string;
  generatedAt?: Date;
  formatValue?: (v: unknown) => string;
  /** noop hook for future formatting pipelines */
  __rows?: T[];
}

/**
 * Build the complete standalone HTML for an elite A4 report document —
 * pure (no DOM), so it can also be used for previews and tests.
 * `printReport` wraps this with the print-window plumbing.
 */
export function buildReportHtml<T>(
  doc: ReportDoc<T>,
  settings: ReportSettings,
  opts?: { rtl?: boolean; generatedAt?: Date; paper?: "A4" | "A5"; pageNumbers?: boolean }
): string {
  return reportHtml(doc, settings, opts);
}

/**
 * Open a print window with an elite A4 report document.
 * Never throws — a blocked popup is surfaced via the callback so the
 * caller can show a toast.
 */
export function printReport<T>(
  doc: ReportDoc<T>,
  settings: ReportSettings,
  opts?: { rtl?: boolean; onBlocked?: () => void; windowTitle?: string; paper?: "A4" | "A5"; pageNumbers?: boolean }
): void {
  const html = buildReportHtml(doc, settings, { rtl: opts?.rtl, paper: opts?.paper, pageNumbers: opts?.pageNumbers });
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

/**
 * In-app preview: show this document in the global PrintPreview modal
 * instead of opening a print window. Client-side only (dynamically
 * imported so server bundles never pull the React component in).
 */
export async function previewReport<T>(
  doc: ReportDoc<T>,
  settings: ReportSettings,
  opts?: { rtl?: boolean; filename?: string; paper?: "A4" | "A5"; pageNumbers?: boolean }
): Promise<void> {
  const html = buildReportHtml(doc, settings, { rtl: opts?.rtl, paper: opts?.paper, pageNumbers: opts?.pageNumbers });
  const { openPrintPreview } = await import("@/components/print/print-preview");
  openPrintPreview(html, opts?.filename ?? "report");
}

/** Convenience: money column total helper (cents in → formatted label). */
export function moneyTotal(rows: Array<Record<string, unknown>>, key: string): string {
  const sum = rows.reduce((acc, r) => acc + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);
  return formatCurrencyBase(sum);
}
