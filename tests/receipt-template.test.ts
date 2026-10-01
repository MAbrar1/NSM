/* ═══════════════════════════════════════════════════════════════
   RECEIPT TEMPLATE — render tests (HTML level)
   The template is pure HTML generation, so structure is testable
   without a browser: 1 vs 10 vs 100 vs 500 items produce
   proportionally more line blocks; the width comes from the profile
   (never hardcoded); RTL/Urdu is dir-correct; no arithmetic leaks —
   every amount is a pre-formatted string passed through the one
   money formatter. True DOM height measurement (fonts.ready →
   getBoundingClientRect) needs a webview and is covered by the
   manual calibration print (M4), stated plainly there.
   Run: npx tsx --test tests/receipt-template.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReceiptBody, renderReceiptDocument, RECEIPT_TEMPLATE_VERSION } from "@/lib/print/receipt-template";
import { buildReportHtml, type ReportDoc } from "@/lib/print/print-report";
import { buildReceiptSnapshot, type ReceiptSnapshot } from "@/lib/receipts/receipt-snapshot";
import { centsToMajorString } from "@/lib/money/money";

const fmt = (cents: number) => `Rs ${centsToMajorString(cents)}`;

function snapshotWithItems(n: number): ReceiptSnapshot {
  const items = Array.from({ length: n }, (_, i) => ({
    productName: `Product ${i + 1}`,
    sku: `SKU-${i + 1}`,
    quantity: 1,
    unit: "pcs",
    unitPrice: 500,
    discountAmount: 0,
    taxRate: 0,
    taxAmount: 0,
    total: 500,
  }));
  return buildReceiptSnapshot({
    receiptNo: "R-T1-000001",
    terminalId: "T1",
    issuedAt: new Date("2026-09-29T10:00:00Z"),
    language: "en",
    order: {
      subtotal: 500 * n,
      taxAmount: 0,
      discountAmount: 0,
      total: 500 * n,
      paidAmount: 500 * n,
      changeAmount: 0,
      dueAmount: 0,
      paymentStatus: "paid",
      loyaltyRedeemed: 0,
      loyaltyPointsRedeemed: 0,
      items,
    },
    cashierName: "Ayesha",
    customerName: null,
    customerLoyaltyBalance: 0,
    settings: {
      storeName: "Najjar Super Mart",
      storeAddress: "Main Bazar",
      storePhone: "0300-1234567",
      receiptHeader: null,
      receiptFooter: null,
      receiptUrduDigits: false,
      receiptQrPayment: null,
    },
  });
}

test("template version constant matches the snapshot module", () => {
  // The snapshot module and the template must agree on the current
  // version — a mismatch would break hash verification on reprints.
  const { RECEIPT_TEMPLATE_VERSION: snapshotVersion } = require("@/lib/receipts/receipt-snapshot") as {
    RECEIPT_TEMPLATE_VERSION: number;
  };
  assert.equal(snapshotVersion, RECEIPT_TEMPLATE_VERSION);
});

test("line count scales with items: 1, 10, 100, 500", () => {
  for (const n of [1, 10, 100, 500]) {
    const html = renderReceiptBody(snapshotWithItems(n), fmt, { widthPx: 302 });
    const lineCount = (html.match(/class="line"/g) ?? []).length;
    assert.equal(lineCount, n, `${n} items → ${n} .line blocks`);
  }
});

test("width comes from the profile, never hardcoded", () => {
  const html = renderReceiptDocument(snapshotWithItems(2), { widthPx: 302 });
  const html88 = renderReceiptDocument(snapshotWithItems(2), { widthPx: 332 });
  assert.ok(html.includes("width: 302px"), "58/80mm-ish width applied");
  assert.ok(html88.includes("width: 332px"), "custom 88mm width applied");
  assert.ok(html88.includes("@page { size: 332px auto; margin: 0; }"), "auto-length roll @page");
});

test("no arithmetic in the template: amounts are formatter output", () => {
  const snap = snapshotWithItems(2);
  const html = renderReceiptBody(snap, fmt, { widthPx: 302 });
  assert.ok(html.includes("Rs 5.00"), "unit price formatted via fmt");
  assert.ok(html.includes("Rs 10.00"), "total formatted via fmt");
  assert.ok(!html.includes("500 /"), "no raw arithmetic");
});

test("Urdu/RTL render marks dir and uses the bundled fonts", () => {
  const html = renderReceiptDocument(snapshotWithItems(1), { widthPx: 302, language: "ur" });
  assert.ok(html.includes('dir="rtl"'));
  // Urdu body = Noto Naskh Arabic (bundled, local).
  assert.ok(html.includes("Noto Naskh Arabic"));
  assert.ok(html.includes("/fonts/noto-naskh-arabic-arabic-400-normal.woff2"), "local font, no network");
  assert.ok(!html.includes("Jameel"), "no proprietary-derived font names");
});

test("SPEC: Nastaliq never rides the thermal receipt path", () => {
  // The typography spec scopes Nastaliq to A4/A5 report letterheads;
  // it rasterizes to mud at receipt sizes. The receipt document (which
  // drives preview, measurement AND the thermal band raster) must not
  // reference it at all.
  for (const lang of ["en", "ur", "bilingual"] as const) {
    const html = renderReceiptDocument(snapshotWithItems(1), { widthPx: 302, language: lang });
    assert.ok(!html.includes("Nastaliq"), `${lang}: no Nastaliq @font-face on the thermal path`);
    assert.ok(!html.includes("noto-nastaliq"), `${lang}: no Nastaliq font file on the thermal path`);
  }
  // The A4/A5 report renderer keeps the Nastaliq letterhead masthead.
  const report = buildReportHtml(
    { title: "T", columns: [{ label: "N", value: (r: { n: string }) => r.n }], rows: [{ n: "x" }] },
    { storeName: "نئیجار سپر مارٹ" },
    { rtl: true }
  );
  assert.ok(report.includes("Noto Nastaliq Urdu"), "Nastaliq stays on the A4/A5 masthead");
});

test("Urdu digits are opt-in: Western numerals by default", () => {
  const snap = snapshotWithItems(1);
  const western = renderReceiptDocument(snap, { widthPx: 302, language: "ur" });
  assert.ok(!/[\u06F0-\u06F9]/.test(western), "default: Western numerals");
  const urduDigits = renderReceiptDocument(
    { ...snap, urduDigits: true },
    { widthPx: 302, language: "ur" }
  );
  assert.match(urduDigits, /[\u06F0-\u06F9]/, "opt-in flag renders Urdu-Indic digits");
});

test("duplicate and fiscal blocks render on demand", () => {
  const snap = snapshotWithItems(1);
  const dup = renderReceiptBody(snap, fmt, {
    widthPx: 302,
    duplicate: { count: 3 },
    fiscal: { invoiceNo: "7000001WI0", qrPayload: "ABC123" },
  });
  assert.ok(dup.includes("DUPLICATE COPY · 3"));
  assert.ok(dup.includes("7000001WI0"));
  assert.ok(dup.includes('data-qr-payload="ABC123"'));

  const fresh = renderReceiptBody(snap, fmt, { widthPx: 302 });
  assert.ok(fresh.includes("Fiscalization pending"), "offline state shown pre-fiscal");
  assert.ok(fresh.includes("ORIGINAL"));
});
