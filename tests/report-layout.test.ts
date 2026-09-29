/* ═══════════════════════════════════════════════════════════════
   REPORT LAYOUT — structure tests
   The report HTML is pure, so layout contracts are testable:
   - @page size follows the requested paper (A4 default, A5 opt-in)
   - page numbers opt-in adds the footer hook (WebKitGTK has no
     @page margin-box support — the JS footer is the fallback)
   - repeated table headers and unbreakable rows remain present
   - RTL/Urdu documents carry dir + the local font reference
   Run: npx tsx --test tests/report-layout.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReportHtml, type ReportDoc } from "@/lib/print-report";

const doc: ReportDoc<{ name: string; total: number }> = {
  title: "Sales Report",
  columns: [
    { label: "Name", value: (r) => r.name },
    { label: "Total", value: (r) => String(r.total), align: "right", numeric: true },
  ],
  rows: [
    { name: "Coffee", total: 1500 },
    { name: "Tea", total: 900 },
  ],
};

test("@page defaults to A4 and honors the A5 option", () => {
  const a4 = buildReportHtml(doc, { storeName: "NSM" });
  assert.match(a4, /@page \{ size: A4;/);
  const a5 = buildReportHtml(doc, { storeName: "NSM" }, { paper: "A5" });
  assert.match(a5, /@page \{ size: A5;/);
});

test("page numbers are opt-in and inject the footer script", () => {
  const plain = buildReportHtml(doc, { storeName: "NSM" });
  assert.ok(!plain.includes("data-page-of"), "default: no page-number hook");
  const numbered = buildReportHtml(doc, { storeName: "NSM" }, { pageNumbers: true });
  assert.ok(numbered.includes("data-page-of"), "opt-in: footer hook present");
});

test("thead repetition and row-break avoidance stay in the layout", () => {
  const html = buildReportHtml(doc, { storeName: "NSM" });
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.match(html, /page-break-inside: avoid/);
});

test("RTL report carries dir and Urdu footer label", () => {
  const rtl = buildReportHtml(doc, { storeName: "NSM" }, { rtl: true });
  assert.match(rtl, /dir="rtl" lang="ur"/);
  assert.ok(rtl.includes("دستاویز"));
});

test("A5 + RTL + page numbers compose", () => {
  const html = buildReportHtml(doc, { storeName: "NSM" }, { paper: "A5", rtl: true, pageNumbers: true });
  assert.match(html, /@page \{ size: A5;/);
  assert.match(html, /data-page-of/);
  assert.match(html, /dir="rtl"/);
});
