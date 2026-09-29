/* ═══════════════════════════════════════════════════════════════
   EXPORT TOOLKIT — one elite, shared implementation for every page.
   All client-side import/export flows funnel through here so:

   - Encoding: every download is UTF-8 with a BOM → Excel opens
     Urdu/Arabic/emoji content correctly (without the BOM Excel
     decodes as Windows-1252 and garbles it — the bug the old
     hand-rolled downloads had).
   - Line endings: CRLF (RFC-4180) so Excel on Windows splits rows.
   - Quoting: RFC-4180 exact (quote when needed, escape "" inside).
   - Injection guard: cells that could execute as spreadsheet
     formulas (=SUM(...), +CMD, @import) are neutralised on export
     so a malicious product name can never become live code in a
     customer's Excel — an OWASP-recommended defence.
   - Excel: `downloadExcel` writes a real, styled .xlsx (frozen
     header row, dark header band, money/percent number formats,
     sized columns, multi-sheet) with ZERO dependencies — the ZIP
     container is assembled byte-by-byte below.
   - Parsing: symmetric RFC-4180 parser mirroring the server's
     import routes — quoted fields, escaped quotes, \r\n, \n.
   - Templates: import-template downloads carry headers + example
     rows so users always know the accepted shape.
   ═══════════════════════════════════════════════════════════════ */


/** UTF-8 BOM — makes Excel decode the file as UTF-8. */
const BOM = "\uFEFF";

/** Excel header-band fill: --neu-accent-solid (#0e7490) — the same
 *  mode-stable solid the on-screen accent uses, so an exported sheet and
 *  the app read as one product. This module runs in the browser bundle so
 *  it can't import print-brand.ts (node:fs); the hex is kept in sync by
 *  `tests/print-brand-sync.test.ts`.
 *
 *  White on it is 5.36:1, so the band stays legible even at 9pt. */
const BAND_HEX = "0E7490";

/* ────────────────────────────────────────────────────────────────
   CSV
   ──────────────────────────────────────────────────────────────── */

/**
 * Neutralise spreadsheet formula injection: a cell beginning with
 * = + @ (or - followed by a non-digit) is prefixed with `'` so
 * Excel/Sheets treat it as text instead of executing it. Real
 * negative numbers ("-5", "-5.25") are preserved untouched.
 */
export function csvSafeCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/^[=+@]/.test(s) || /^-(?!\d|\.\d)/.test(s) || /^[\t\r]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

/** Quote a single cell only when RFC-4180 requires it. */
function quoteCell(value: unknown): string {
  const s = csvSafeCell(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build a full CSV string from header + data rows. */
export function toCsv(headers: string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines = [headers, ...rows].map((r) => r.map(quoteCell).join(","));
  return lines.join("\r\n");
}

/** Date stamp used in filenames: products-2026-09-23.csv */
export function stampFilename(prefix: string, ext = "csv"): string {
  return `${prefix}-${new Date().toISOString().split("T")[0]}.${ext}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Give the browser a tick to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

/** Trigger a client-side download of a CSV (BOM-prefixed). */
export function downloadCsv(filename: string, headers: string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): void {
  const blob = new Blob([BOM + toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, stampFilename(filename));
}

/** Download an import TEMPLATE: headers + example rows, named `…-template.csv`. */
export function downloadTemplate(filename: string, headers: string[], exampleRows: ReadonlyArray<ReadonlyArray<unknown>>): void {
  const blob = new Blob([BOM + toCsv(headers, exampleRows)], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, stampFilename(`${filename}-template`));
}

/* ────────────────────────────────────────────────────────────────
   Minimal RFC-4180 CSV parser (client-side mirror of the server's
   import parser): handles quoted fields, escaped quotes, \r\n and
   \n. Blank rows are dropped. Returns rows of cell strings.
   ──────────────────────────────────────────────────────────────── */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);

  return rows;
}

/* The one money-cell rule, re-exported from lib/money so existing
   `parseMoneyToCents` callers and tests keep their import path while
   the implementation lives in exactly one place. Pure and dependency-
   free, so it stays safe in the browser bundle. */
export { parseMoneyToCents } from "@/lib/money";

/* ════════════════════════════════════════════════════════════════
   EXCEL (.xlsx) WRITER — dependency-free
   Assembles a minimal but fully-valid OOXML spreadsheet package
   (ZIP container + XML parts) in the browser. Supports:
   - multi-sheet workbooks
   - styled header band (dark fill, white bold) with a FROZEN top row
   - money / integer / percent / bold cell styles
   - auto-sized columns
   ════════════════════════════════════════════════════════════════ */

export type XlsxStyle =
  | "text"
  | "header"
  | "money"
  | "int"
  | "percent"
  | "bold"
  | "money-bold"
  | "int-bold";

/** A cell: a plain value, a styled value, or a formula. */
export type XlsxCell =
  | string
  | number
  | boolean
  | null
  | undefined
  | { v: string | number | boolean | null | undefined; style?: XlsxStyle }
  | { f: string; style?: XlsxStyle };

export interface ExcelSheet {
  /** Sheet tab name (sanitised: ≤31 chars, no []:*?/\ ). */
  name: string;
  headers: string[];
  rows: ReadonlyArray<ReadonlyArray<XlsxCell>>;
  /** Bold totals row appended under the data. Formula cells
   *  (`{ f: "SUM(D2:D99)" }`) recalculate on open in Excel/LibreOffice.
   *  Excluded from auto column widths. */
  totals?: ReadonlyArray<XlsxCell>;
}

/* ── ZIP plumbing (stored/no-compression entries + CRC-32) ─────── */

const CRC_TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Build a valid ZIP archive (STORE method, UTF-8 file names). */
function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    dv.setUint16(8, 0, true); // method: stored
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0x21, true); // mod date (1980-01-01)
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);
    locals.push(local, e.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags: UTF-8 names
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0x21, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);
    centrals.push(cd);

    offset += local.length + size;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

/* ── XML helpers ───────────────────────────────────────────────── */

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // strip control chars that are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** Excel column letter: 0→A, 25→Z, 26→AA … */
function colLetter(index: number): string {
  let s = "";
  let n = index;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/** Sanitise a sheet name to Excel's rules (≤31 chars, no []:*?/\). */
function safeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${i}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** style name → cellXfs index (matches styles.xml below). */
const STYLE_XF: Record<Exclude<XlsxStyle, "text">, number> = {
  header: 1,
  money: 2,
  int: 3,
  percent: 4,
  bold: 5,
  "money-bold": 6,
  "int-bold": 7,
};

/** Build a SUM formula cell for a data column (header row = 1,
 *  data rows 2…rowCount+1). Numeric style keeps the number format. */
export function sumFormulaCell(
  colIndex: number,
  rowCount: number,
  style: Extract<XlsxStyle, "money-bold" | "int-bold">
): { f: string; style: XlsxStyle } {
  const L = colLetter(colIndex);
  return { f: `SUM(${L}2:${L}${Math.max(rowCount + 1, 2)})`, style };
}

interface NormalizedCell {
  text: string;
  num: number | null;
  style: XlsxStyle;
  isNumber: boolean;
  isBoolean: boolean;
  formula: string | null;
}

function normalizeCell(cell: XlsxCell): NormalizedCell {
  if (cell != null && typeof cell === "object") {
    if ("f" in cell) {
      return { text: `=${cell.f}`, num: null, style: cell.style ?? "bold", isNumber: false, isBoolean: false, formula: cell.f };
    }
    const inner = normalizeCell(cell.v as XlsxCell);
    return cell.style ? { ...inner, style: cell.style } : { ...inner, formula: null };
  }
  if (typeof cell === "number") {
    return {
      text: String(cell),
      num: Number.isFinite(cell) ? cell : null,
      style: "text",
      isNumber: Number.isFinite(cell),
      isBoolean: false,
      formula: null,
    };
  }
  if (typeof cell === "boolean") {
    return { text: cell ? "TRUE" : "FALSE", num: null, style: "text", isNumber: false, isBoolean: true, formula: null };
  }
  return { text: cell == null ? "" : String(cell), num: null, style: "text", isNumber: false, isBoolean: false, formula: null };
}

/** Numeric text coerced to a real number when a style needs one:
 *  money/int cells carrying "1234.50" become numeric cells so Excel's
 *  number format actually applies and SUM works. Percent style is
 *  `0.0%`, so a value like 12.5 must be divided by 100 (→ 12.5%).
 *  Returns null when the text is not purely numeric. */
function numericValue(text: string, style: XlsxStyle): number | null {
  if (style !== "money" && style !== "int" && style !== "percent") return null;
  // Strip thousands separators (the store's 1,234.56 display format) and
  // a trailing % on percent cells so formatted values still coerce.
  const s = text.trim().replace(/^'/, "").replace(/,/g, "").replace(/%$/, "");
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return style === "percent" ? n / 100 : n;
}

function cellXml(ref: string, cell: NormalizedCell, forceStyle?: XlsxStyle): string {
  const style = forceStyle ?? cell.style;
  const sAttr = style !== "text" ? ` s="${STYLE_XF[style]}"` : "";
  // Formula cell: Excel/LibreOffice recalculate on open (fullCalcOnLoad).
  if (cell.formula != null) {
    return `<c r="${ref}"${sAttr}><f>${escXml(cell.formula)}</f></c>`;
  }
  // A styled text cell holding numeric content becomes a real number
  // so the Excel number format (money/int/percent) renders correctly.
  if (!cell.isNumber && !cell.isBoolean) {
    const numeric = numericValue(cell.text, style);
    if (numeric != null) return `<c r="${ref}"${sAttr}><v>${numeric}</v></c>`;
  }
  if (cell.isNumber) return `<c r="${ref}"${sAttr}><v>${cell.num}</v></c>`;
  if (cell.isBoolean) return `<c r="${ref}" t="b"${sAttr}><v>${cell.text === "TRUE" ? 1 : 0}</v></c>`;
  const text = csvSafeCell(cell.text);
  if (text === "") return `<c r="${ref}"${sAttr}/>`;
  return `<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${escXml(text)}</t></is></c>`;
}

function sheetXml(sheet: ExcelSheet, safeName: string): string {
  const header = sheet.headers.map((h, c) => cellXml(`${colLetter(c)}1`, normalizeCell(h), "header")).join("");

  const bodyRows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => cellXml(`${colLetter(c)}${r + 2}`, normalizeCell(cell)))
        .join("");
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join("");

  // Bold totals row under the data (formulas recalc on open)
  const lastDataRow = sheet.rows.length + 1;
  const totalsRow =
    sheet.totals && sheet.totals.length > 0
      ? `<row r="${lastDataRow + 1}">${sheet.totals
          .map((cell, c) => cellXml(`${colLetter(c)}${lastDataRow + 1}`, normalizeCell(cell)))
          .join("")}</row>`
      : "";

  // Auto column widths from content length (clamped 8–55 chars);
  // the totals row is excluded so formulas don't stretch columns.
  const cols = sheet.headers
    .map((h, c) => {
      let max = String(h).length;
      for (const row of sheet.rows) {
        const len = normalizeCell(row[c]).text.length;
        if (len > max) max = len;
      }
      const width = Math.min(55, Math.max(8, max + 3));
      return `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15.75"/>
<cols>${cols}</cols>
<sheetData><row r="1">${header}</row>${bodyRows}${totalsRow}</sheetData>
</worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
{SHEET_OVERRIDES}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="#,##0.00"/>
<numFmt numFmtId="165" formatCode="0.0%"/>
</numFmts>  <fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${BAND_HEX}"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Build a real .xlsx workbook as bytes — no dependencies, no DOM.
 * The top row of every sheet is frozen and styled as a dark header
 * band; numbers carry proper formats so Excel sums/sorts correctly.
 * `downloadExcel` wraps this with the browser download trigger.
 */
export function buildXlsx(sheets: ExcelSheet[]): Uint8Array {
  const used = new Set<string>();
  const safeNames = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));
  const names = safeNames.map((s) => s.name);

  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];

  entries.push({
    name: "[Content_Types].xml",
    data: enc.encode(
      CONTENT_TYPES_XML.replace(
        "{SHEET_OVERRIDES}",
        safeNames.map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        ).join("\n")
      )
    ),
  });
  entries.push({ name: "_rels/.rels", data: enc.encode(ROOT_RELS_XML) });
  entries.push({
    name: "xl/workbook.xml",
    data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names
        .map((n, i) => `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets>
<calcPr calcId="0" fullCalcOnLoad="1"/>
</workbook>`
    ),
  });
  entries.push({
    name: "xl/_rels/workbook.xml.rels",
    data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${safeNames
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join("\n")}
<Relationship Id="rId${safeNames.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    ),
  });
  entries.push({ name: "xl/styles.xml", data: enc.encode(STYLES_XML) });
  safeNames.forEach((s, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s, names[i]!)) });
  });

  return buildZip(entries);
}

/* ────────────────────────────────────────────────────────────────
   Styled-sheet helper
   Maps ExportColumn-style configs (header / value / excelStyle) to an
   ExcelSheet, with an optional formula totals row. One implementation
   for every page — no more hand-mapped cell arrays.
   ──────────────────────────────────────────────────────────────── */

/** Minimal structural shape the helper needs — ExportColumn satisfies it. */
export interface SheetColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
  /** Excel cell override (defaults to the CSV value). */
  excel?: (row: T) => unknown;
  excelStyle?: "money" | "int" | "percent" | "bold";
  omitExcel?: boolean;
}

export interface SheetTotals<T> {
  /** Label for the first cell of the totals row. */
  label: string;
  /** Columns to total with a live SUM formula, matched by `header`.
   *  (The referenced column must appear in `columns`.) */
  sum: Array<{
    header: string;
    style: "money-bold" | "int-bold";
  }>;
}

/**
 * Build a styled ExcelSheet from column configs, with an optional
 * bold totals row whose SUMs are live formulas (recalculate on open,
 * so they stay correct after users filter/edit the sheet).
 */
export function buildStyledSheet<T>(
  name: string,
  columns: ReadonlyArray<SheetColumn<T>>,
  rows: ReadonlyArray<T>,
  totals?: SheetTotals<T>
): ExcelSheet {
  const cols = columns.filter((c) => !c.omitExcel);
  const sheet: ExcelSheet = {
    name,
    headers: cols.map((c) => c.header),
    rows: rows.map((r) =>
      cols.map((c): XlsxCell => {
        const v = c.excel ? c.excel(r) : c.value(r);
        return c.excelStyle ? { v: (v ?? null) as string | number | boolean | null, style: c.excelStyle } : (v as XlsxCell);
      })
    ),
  };
  if (totals) {
    const cells: XlsxCell[] = cols.map(() => null);
    cells[0] = { v: totals.label, style: "bold" };
    for (const s of totals.sum) {
      const idx = cols.findIndex((c) => c.header === s.header);
      if (idx >= 0) cells[idx] = sumFormulaCell(idx, rows.length, s.style);
    }
    sheet.totals = cells;
  }
  return sheet;
}

/**
 * Build and download a real .xlsx workbook (browser-only wrapper).
 */
export function downloadExcel(filename: string, sheets: ExcelSheet[]): void {
  const blob = new Blob([buildXlsx(sheets) as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerDownload(blob, stampFilename(filename, "xlsx"));
}
