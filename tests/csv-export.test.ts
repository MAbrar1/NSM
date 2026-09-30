/* ═══════════════════════════════════════════════════════════════
   CSV / EXPORT TOOLKIT — unit tests
   Locks the shared export engine used by every page: RFC-4180
   quoting, the spreadsheet formula-injection guard, the symmetric
   parser, money→cents parsing, filename stamping and the ZIP
   container of the dependency-free .xlsx writer.
   Run: npx tsx --test tests/csv-export.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csvSafeCell,
  toCsv,
  parseCsv,
  parseMoneyToCents,
  stampFilename,
  buildXlsx,
  sumFormulaCell,
} from "@/lib/files/csv";

/* ── CSV injection guard ─────────────────────────────────────── */

test("csvSafeCell: neutralises formula-leading cells", () => {
  assert.equal(csvSafeCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(csvSafeCell("+CMD /c calc"), "'+CMD /c calc");
  assert.equal(csvSafeCell("@import"), "'@import");
  assert.equal(csvSafeCell("\tTAB"), "'\tTAB");
  assert.equal(csvSafeCell("\rCR"), "'\rCR");
});

test("csvSafeCell: keeps real numbers and negative numbers untouched", () => {
  assert.equal(csvSafeCell("5"), "5");
  assert.equal(csvSafeCell("-5"), "-5");
  assert.equal(csvSafeCell("-5.25"), "-5.25");
  assert.equal(csvSafeCell("plain text"), "plain text");
  assert.equal(csvSafeCell(""), "");
  assert.equal(csvSafeCell(null), "");
  assert.equal(csvSafeCell(undefined), "");
  assert.equal(csvSafeCell(0), "0");
});

/* ── RFC-4180 building ───────────────────────────────────────── */

test("toCsv: quotes only when required and escapes inner quotes", () => {
  const out = toCsv(["a", "b"], [["plain", 'say "hi"'], ["x,y", "line\nbreak"]]);
  assert.equal(out, 'a,b\r\nplain,"say ""hi"""\r\n"x,y","line\nbreak"');
});

test("toCsv: injection guard is applied inside cells", () => {
  const out = toCsv(["h"], [["=1+1"]]);
  assert.equal(out, "h\r\n'=1+1");
});

/* ── Parser round-trip ───────────────────────────────────────── */

test("parseCsv: round-trips quoted commas, quotes and newlines", () => {
  const original = 'a,b\r\n"x,y","line\nbreak"\r\n"say ""hi""",plain';
  const rows = parseCsv(original);
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x,y", "line\nbreak"],
    ['say "hi"', "plain"],
  ]);
});

test("parseCsv: drops blank rows and handles \\n-only files", () => {
  const rows = parseCsv("a,b\n\n1,2\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

/* ── Money parsing ───────────────────────────────────────────── */

test("parseMoneyToCents: handles currency symbols, thousands and decimals", () => {
  assert.equal(parseMoneyToCents("$1,234.50"), 123450);
  // Commas are thousands separators (store format 1,234.56), not decimal marks.
  assert.equal(parseMoneyToCents("12,50"), 125000);
  assert.equal(parseMoneyToCents("7"), 700);
  assert.equal(parseMoneyToCents(" 0.05 "), 5);
});

test("parseMoneyToCents: rejects junk and negatives", () => {
  assert.equal(parseMoneyToCents(""), null);
  assert.equal(parseMoneyToCents(undefined), null);
  assert.equal(parseMoneyToCents("abc"), null);
  assert.equal(parseMoneyToCents("-3"), null);
});

/* ── Filename stamping ───────────────────────────────────────── */

test("stampFilename: appends the ISO date and extension", () => {
  const today = new Date().toISOString().split("T")[0];
  assert.equal(stampFilename("products"), `products-${today}.csv`);
  assert.equal(stampFilename("inventory", "xlsx"), `inventory-${today}.xlsx`);
});

/* ── .xlsx ZIP container (dependency-free writer) ────────────── */

/** Re-parse the built ZIP locally: read local headers + collect parts. */
function readZip(bytes: Uint8Array): Map<string, string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const sig = dv.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // EOCD reached
    const method = dv.getUint16(offset + 8, true);
    const compressedSize = dv.getUint32(offset + 18, true);
    const nameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    assert.equal(method, 0, "entries must be STOREd (no compression)");
    files.set(name, new TextDecoder().decode(bytes.subarray(dataStart, dataStart + compressedSize)));
    offset = dataStart + compressedSize;
  }
  return files;
}

test("buildXlsx: valid ZIP container with one part per sheet + styles", () => {
  const bytes = buildXlsx([
    { name: "Alpha", headers: ["a"], rows: [["1"]] },
    { name: "Beta", headers: ["b"], rows: [["2"]] },
  ]);
  const files = readZip(bytes);

  assert.ok(files.has("[Content_Types].xml"));
  assert.ok(files.has("_rels/.rels"));
  assert.ok(files.has("xl/workbook.xml"));
  assert.ok(files.has("xl/_rels/workbook.xml.rels"));
  assert.ok(files.has("xl/styles.xml"));
  assert.ok(files.has("xl/worksheets/sheet1.xml"));
  assert.ok(files.has("xl/worksheets/sheet2.xml"));

  const wb = files.get("xl/workbook.xml")!;
  assert.match(wb, /<sheet name="Alpha" sheetId="1"/);
  assert.match(wb, /<sheet name="Beta" sheetId="2"/);

  const ct = files.get("[Content_Types].xml")!;
  assert.match(ct, /PartName="\/xl\/worksheets\/sheet1\.xml"/);
  assert.match(ct, /PartName="\/xl\/worksheets\/sheet2\.xml"/);
});

test("buildXlsx: frozen header, styled header band, number formats", () => {
  const bytes = buildXlsx([
    {
      name: "Data",
      headers: ["item", "price", "qty"],
      rows: [["Widget", { v: "1234.50", style: "money" as const }, { v: 7, style: "int" as const }]],
    },
  ]);
  const sheet = readZip(bytes).get("xl/worksheets/sheet1.xml")!;

  // frozen top row
  assert.match(sheet, /state="frozen"/);
  // header band style (xf 1 = dark fill + white bold)
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"/);
  // money style (xf 2 → numFmt 164 "#,##0.00") on a NUMERIC cell
  assert.match(sheet, /<c r="B2" s="2"><v>1234\.5<\/v><\/c>/);
  // int style (xf 3) numeric
  assert.match(sheet, /<c r="C2" s="3"><v>7<\/v><\/c>/);
});

test("buildXlsx: percent style stores the fraction (12.5 → 0.125 → renders 12.5%)", () => {
  const bytes = buildXlsx([
    { name: "S", headers: ["rate"], rows: [[{ v: "12.5", style: "percent" as const }]] },
  ]);
  const sheet = readZip(bytes).get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /<c r="A2" s="4"><v>0\.125<\/v><\/c>/);
});

test("buildXlsx: sheet names sanitised and de-duplicated (Excel 31-char rule)", () => {
  const bytes = buildXlsx([
    { name: "Very Long Sheet Name That Exceeds Thirty One Characters", headers: ["x"], rows: [] },
    { name: "Bad/Name*Here?", headers: ["x"], rows: [] },
    { name: "Bad:Name*Here?", headers: ["x"], rows: [] },
  ]);
  const wb = readZip(bytes).get("xl/workbook.xml")!;
  // clamped to 31 chars
  assert.match(wb, /name="Very Long Sheet Name That Excee"/);
  // illegal characters replaced with spaces
  assert.doesNotMatch(wb, /name="Bad[/:*?]/);
  // the two sanitised-collision names get unique suffixes
  assert.match(wb, /name="Bad Name Here" /);
  assert.match(wb, /name="Bad Name Here 2"/);
});

test("buildXlsx: XML escaping and illegal control chars stripped", () => {
  const bytes = buildXlsx([
    { name: "S", headers: ["note"], rows: [["<b> & \'quoted\' \\u0007ding\\u001B"]] },
  ]);
  const sheet = readZip(bytes).get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /&lt;b&gt; &amp; &apos;quoted&apos;/);
  assert.doesNotMatch(sheet, /\u0007|\u001B/);
});

test("print engines: buildReportHtml / buildPurchaseOrderHtml are pure and structured", async () => {
  const { buildReportHtml } = await import("@/lib/print/print-report");
  const { buildPurchaseOrderHtml } = await import("@/lib/print/print-purchase-order");

  const settings = { storeName: "Test Mart", storePhone: "+92 300 0000000" };
  const html = buildReportHtml(
    {
      title: "Test Report",
      kicker: "Kicker",
      kpis: [{ label: "K", value: "1", tone: "positive" }],
      columns: [{ label: "N", value: (r: { n: string }) => r.n, total: () => "9" }],
      rows: [{ n: "row-1" }],
      totalsLabel: "Total",
    },
    settings,
    { rtl: false, generatedAt: new Date("2026-09-23T00:00:00") }
  );
  assert.match(html, /<title>Test Report<\/title>/);
  assert.match(html, /dir="ltr"/);
  assert.match(html, /Test Mart/);
  assert.match(html, /row-1/);
  assert.match(html, /Total/);
  assert.match(html, /@page \{ size: A4/);
  // escaping — the ONLY allowed scripts are the two known CSP-safe
  // snippets (scheme bootstrap + page measurement; neither evals).
  const scripts = html.match(/<script[\s\S]*?<\/script>/g) ?? [];
  assert.ok(scripts.length <= 2, "print documents must not embed arbitrary scripts");
  for (const s of scripts) {
    assert.match(s, /najjar\.print-scheme|najjar-print-page-info/, "unexpected script embedded in print document");
    assert.doesNotMatch(s, /\beval\b|new Function/);
  }
  // user content must never be able to inject a script tag
  assert.doesNotMatch(html, /<script(?![^>]*>\(function\(\))/);

  const rtl = buildReportHtml(
    { title: "ت report", columns: [{ label: "N", value: (r: { n: string }) => r.n }], rows: [] },
    settings,
    { rtl: true, generatedAt: new Date("2026-09-23T00:00:00") }
  );
  assert.match(rtl, /dir="rtl" lang="ur"/);

  const po = buildPurchaseOrderHtml(
    {
      poNumber: "PO-000001",
      status: "ordered",
      orderDate: "Sep 23, 2026",
      supplier: { name: "Acme Ltd" },
      items: [{ productName: "Widget", sku: "W-1", quantity: 4, unitCost: 1000, lineTotal: 4000 }],
    },
    settings,
    { generatedAt: new Date("2026-09-23T00:00:00") }
  );
  assert.match(po, /PO-000001/);
  assert.match(po, /Acme Ltd/);
  assert.match(po, /Widget/);
  // subtotal row present in tfoot
  assert.match(po, /Subtotal/);
});

/* ── Excel formulas + totals rows ────────────────────────────── */

test("sumFormulaCell: builds a range over the data rows with the bold numeric style", () => {
  const cell = sumFormulaCell(3, 41, "money-bold");
  assert.equal(cell.f, "SUM(D2:D42)");
  assert.equal(cell.style, "money-bold");
  assert.equal(sumFormulaCell(0, 5, "int-bold").f, "SUM(A2:A6)");
  // zero data rows still yields a valid range
  assert.equal(sumFormulaCell(1, 0, "int-bold").f, "SUM(B2:B2)");
});

test("buildXlsx: totals row emits formulas, excluded from column widths", () => {
  const bytes = buildXlsx([
    {
      name: "S",
      headers: ["item", "amount", "qty"],
      rows: [
        ["A", { v: "100.00", style: "money" as const }, { v: 2, style: "int" as const }],
        ["B", { v: "250.50", style: "money" as const }, { v: 3, style: "int" as const }],
      ],
      totals: [
        { v: "Total", style: "bold" as const },
        sumFormulaCell(1, 2, "money-bold"),
        sumFormulaCell(2, 2, "int-bold"),
      ],
    },
  ]);
  const sheet = readZip(bytes).get("xl/worksheets/sheet1.xml")!;
  // totals row = row 4, with real <f> formulas
  assert.match(sheet, /<row r="4"><c r="A4"[^>]*t="inlineStr"[^>]*>.*Total/);
  assert.match(sheet, /<c r="B4" s="6"><f>SUM\(B2:B3\)<\/f><\/c>/);
  assert.match(sheet, /<c r="C4" s="7"><f>SUM\(C2:C3\)<\/f><\/c>/);
  // workbook asks Excel to recalculate on open
  const wb = readZip(bytes).get("xl/workbook.xml")!;
  assert.match(wb, /fullCalcOnLoad="1"/);
});

test("buildXlsx: no totals row when omitted", () => {
  const bytes = buildXlsx([{ name: "S", headers: ["x"], rows: [["a"]] }]);
  const sheet = readZip(bytes).get("xl/worksheets/sheet1.xml")!;
  assert.doesNotMatch(sheet, /<f>/);
});

test("numericValue-style coercion: comma-formatted money becomes a real number", () => {
  const bytes = buildXlsx([
    { name: "S", headers: ["v"], rows: [[{ v: "1,234.56", style: "money" as const }]] },
  ]);
  const sheet = readZip(bytes).get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /<c r="A2" s="2"><v>1234\.56<\/v><\/c>/);
});

test("buildStyledSheet: maps columns, styles and totals by column identity", async () => {
  const { buildStyledSheet } = await import("@/lib/files/csv");
  interface Row {
    name: string;
    qty: number;
    price: number;
  }
  const qtyCol = { header: "qty", value: (r: Row) => r.qty, excelStyle: "int" as const };
  const priceCol = {
    header: "price",
    value: (r: Row) => r.price.toFixed(2),
    excelStyle: "money" as const,
    print: { total: () => "" },
  };
  const sheet = buildStyledSheet<Row>(
    "Items",
    [{ header: "name", value: (r: Row) => r.name }, qtyCol, priceCol],
    [
      { name: "A", qty: 1, price: 10 },
      { name: "B", qty: 2, price: 20 },
    ],
    { label: "Total", sum: [{ header: "price", style: "money-bold" }] }
  );
  assert.deepEqual(sheet.headers, ["name", "qty", "price"]);
  assert.equal(sheet.rows.length, 2);
  assert.ok(sheet.totals, "totals row present");
  assert.equal(sheet.totals!.length, 3);
  // price column (index 2) carries the SUM formula
  assert.equal((sheet.totals![2] as { f: string }).f, "SUM(C2:C3)");
  assert.equal((sheet.totals![0] as { v: string }).v, "Total");
  // omitExcel columns are excluded
  const omitted = buildStyledSheet<{ a: string; b: string }>(
    "X",
    [
      { header: "a", value: (r) => r.a },
      { header: "b", value: (r) => r.b, omitExcel: true },
    ],
    [{ a: "1", b: "2" }]
  );
  assert.deepEqual(omitted.headers, ["a"]);
});
