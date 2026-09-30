/* ═══════════════════════════════════════════════════════════════
   EXPORT SAMPLE GENERATOR — eyeball the styling
   Generates real, openable samples of every export surface using
   the exact same builders the app uses in production:

     samples/sales-report-sample.xlsx   multi-sheet styled workbook
     samples/sales-report-print.html    A4 report doc (LTR)
     samples/sales-report-print-ur.html A4 report doc (RTL / Urdu)
     samples/sales-report-print-dark.html  dark preview variant
     samples/purchase-order-print.html  professional PO document
     samples/purchase-order-print-dark.html dark preview variant
     samples/inventory-report-print.html stock valuation + turnover

   Run:  npm run samples
   Open: start samples/sales-report-print.html — it is print-ready
   (Ctrl+P shows the same paper output the app produces).
   ═══════════════════════════════════════════════════════════════ */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildXlsx, buildStyledSheet, type ExcelSheet } from "@/lib/files/csv";
import { buildReportHtml } from "@/lib/print/print-report";
import { buildPurchaseOrderHtml } from "@/lib/print/print-purchase-order";

const OUT_DIR = join(process.cwd(), "samples");
mkdirSync(OUT_DIR, { recursive: true });

/** Write a sample, tolerating files currently open/locked in Excel or a browser. */
function writeSample(name: string, data: string | Uint8Array): void {
  try {
    writeFileSync(join(OUT_DIR, name), data);
    console.log(`✔ samples/${name}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM") {
      console.warn(`⚠ samples/${name} skipped — file is open in another program. Close it and re-run.`);
    } else {
      throw e;
    }
  }
}

const SETTINGS = {
  storeName: "Najjar Supper Mart",
  storeAddress: "Shop 14, Central Bazaar, Gulberg III",
  storePhone: "+92 300 1234567",
  storeEmail: "hello@najjarmart.example",
};

const GENERATED_AT = new Date("2026-09-23T15:42:00");

/* ─── Elite sample data: a believable month of sales ─────────── */

const topProducts = [
  { name: "Coca-Cola Classic 1.5L", sku: "BEV-0001", quantitySold: 412, revenue: 741_600, orderCount: 305 },
  { name: "Basmati Rice 5kg Premium", sku: "GRN-0042", quantitySold: 128.5, revenue: 1_098_250, orderCount: 121 },
  { name: "Surf Excel Washing Powder 1kg", sku: "HHD-0117", quantitySold: 96, revenue: 383_004, orderCount: 90 },
  { name: "Lipton Yellow Label 450g", sku: "BEV-0388", quantitySold: 88, revenue: 263_112, orderCount: 84 },
  { name: "Dalda Cooking Oil 5L", sku: "GRN-0101", quantitySold: 74, revenue: 814_000, orderCount: 70 },
  { name: "Nestlé Nido 900g", sku: "DRY-0230", quantitySold: 61, revenue: 768_600, orderCount: 58 },
  { name: "K&N's Chicken Nuggets 500g", sku: "FRZ-0055", quantitySold: 54, revenue: 219_240, orderCount: 51 },
  { name: "Colgate MaxFresh 120g", sku: "PCR-0176", quantitySold: 49, revenue: 87_705, orderCount: 47 },
  { name: "Tapal Danedar 950g", sku: "BEV-0401", quantitySold: 43, revenue: 171_570, orderCount: 41 },
  { name: "Sufi Cooking Oil Pouch 1L", sku: "GRN-0118", quantitySold: 41, revenue: 90_200, orderCount: 39 },
];

const categories = [
  { name: "Groceries & Staples", revenue: 2_401_450, quantity: 643.5, items: 214 },
  { name: "Beverages", revenue: 1_176_282, quantity: 543, items: 96 },
  { name: "Dairy & Bakery", revenue: 986_400, quantity: 402, items: 74 },
  { name: "Household Care", revenue: 633_004, quantity: 288, items: 88 },
  { name: "Frozen Foods", revenue: 411_240, quantity: 154, items: 41 },
  { name: "Personal Care", revenue: 302_705, quantity: 191, items: 102 },
];

const paymentMethods = [
  { method: "cash", total: 3_912_455, count: 918 },
  { method: "card", total: 1_412_800, count: 264 },
  { method: "credit", total: 585_826, count: 71 },
];

const summary = {
  totalRevenue: 5_911_081,
  netRevenue: 5_613_527,
  totalTax: 412_776,
  totalDiscounts: 118_940,
  totalOrders: 1_253,
  averageOrderValue: 4_717,
};

function money(cents: number): string {
  return `Rs ${ (cents / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }`;
}

/* ═══ 1. Multi-sheet styled .xlsx workbook ══════════════════════ */

const sheets: ExcelSheet[] = [
  {
    name: "Summary",
    headers: ["metric", "value"],
    rows: [
      ["Total Revenue", { v: (summary.totalRevenue / 100).toFixed(2), style: "money" as const }],
      ["Net Revenue", { v: (summary.netRevenue / 100).toFixed(2), style: "money" as const }],
      ["Total Orders", { v: summary.totalOrders, style: "int" as const }],
      ["Average Order Value", { v: (summary.averageOrderValue / 100).toFixed(2), style: "money" as const }],
      ["Total Tax", { v: (summary.totalTax / 100).toFixed(2), style: "money" as const }],
      ["Total Discounts", { v: (summary.totalDiscounts / 100).toFixed(2), style: "money" as const }],
    ],
  },
  buildStyledSheet(
    "Top Products",
    [
      { header: "name", value: (p: (typeof topProducts)[number]) => p.name },
      { header: "sku", value: (p) => p.sku },
      { header: "qtySold", value: (p) => p.quantitySold, excelStyle: "int" },
      { header: "revenue", value: (p) => (p.revenue / 100).toFixed(2), excelStyle: "money" },
      { header: "orders", value: (p) => p.orderCount, excelStyle: "int" },
    ],
    topProducts,
    { label: "TOTAL", sum: [
      { header: "qtySold", style: "int-bold" },
      { header: "revenue", style: "money-bold" },
    ] }
  ),
  {
    name: "Categories",
    headers: ["category", "revenue", "quantity", "items"],
    rows: categories.map((c) => [
      c.name,
      { v: (c.revenue / 100).toFixed(2), style: "money" as const },
      { v: c.quantity, style: "int" as const },
      { v: c.items, style: "int" as const },
    ]),
  },
  {
    name: "کھاتہ (Urdu sheet)",
    headers: ["کسٹمر", "بقایا", "حالت"],
    rows: [
      ["حاجی صاحب Stores", { v: "12,450.00", style: "money" as const }, "بقایا"],
      ["البا کیش اینڈ کیری", { v: "3,200.50", style: "money" as const }, "جزوی"],
      ["مصلیٰ خان", { v: "0.00", style: "money" as const }, "ادا شدہ"],
    ],
  },
];

writeSample("sales-report-sample.xlsx", buildXlsx(sheets));

/* ═══ 2. A4 sales report — LTR ═════════════════════════════════ */

type SalesRow = (typeof topProducts)[number];

const productColumns = topProducts.map((_, i) => i);
void productColumns;

const ltrHtml = buildReportHtml<SalesRow>(
  {
    title: "Sales Report",
    kicker: "Sales Analytics",
    periodLabel: "Aug 24 → Sep 23, 2026",
    reference: "RPT-SLS-2026-0923",
    kpis: [
      { label: "Total Revenue", value: money(summary.totalRevenue), tone: "positive", hint: "▲ 8.4% vs prev period" },
      { label: "Net Revenue", value: money(summary.netRevenue) },
      { label: "Total Orders", value: summary.totalOrders.toLocaleString(), hint: "1,253 transactions" },
      { label: "Avg Order Value", value: money(summary.averageOrderValue), tone: "warning" },
    ],
    meta: [
      { label: "Total Tax", value: money(summary.totalTax) },
      { label: "Total Discounts", value: money(summary.totalDiscounts) },
      { label: "Cash Payments", value: money(paymentMethods[0]!.total) },
      { label: "Card Payments", value: money(paymentMethods[1]!.total) },
      { label: "Credit (Khata)", value: money(paymentMethods[2]!.total) },
    ],
    sections: [
      {
        title: "Top Products",
        columns: [
          { label: "#", align: "center", width: "5%", value: (row) => String(topProducts.indexOf(row) + 1) },
          { label: "Product", width: "34%", strong: true, value: (row) => row.name },
          { label: "SKU", muted: true, width: "12%", value: (row) => row.sku },
          { label: "Qty Sold", align: "right", value: (row) => row.quantitySold.toLocaleString() },
          { label: "Revenue", align: "right", strong: true, value: (row) => money(row.revenue), total: () => money(summary.totalRevenue) },
          { label: "Orders", align: "right", value: (row) => String(row.orderCount) },
        ],
        rows: topProducts,
        totalsLabel: "Total",
      },
      {
        title: "Revenue by Category",
        columns: [
          { label: "Category", strong: true, value: (c: (typeof categories)[number]) => c.name },
          { label: "Revenue", align: "right", strong: true, value: (c: (typeof categories)[number]) => money(c.revenue), total: () => money(summary.totalRevenue) },
          { label: "Qty", align: "right", value: (c: (typeof categories)[number]) => c.quantity.toLocaleString() },
          { label: "Items", align: "right", value: (c: (typeof categories)[number]) => String(c.items) },
        ],
        rows: categories,
      },
      {
        title: "Payment Methods",
        columns: [
          { label: "Method", strong: true, value: (p: (typeof paymentMethods)[number]) => p.method },
          { label: "Revenue", align: "right", strong: true, value: (p: (typeof paymentMethods)[number]) => money(p.total), total: () => money(summary.totalRevenue) },
          { label: "Orders", align: "right", value: (p: (typeof paymentMethods)[number]) => String(p.count) },
        ],
        rows: paymentMethods,
      },
    ],
    footnote:
      "All amounts in PKR. Credit (khata) balances are carried per customer statement; figures reflect completed orders only.",
    signature: { left: "Prepared by Store Manager", right: "Verified by Owner" },
  },
  SETTINGS,
  { rtl: false, generatedAt: GENERATED_AT }
);
writeSample("sales-report-print.html", ltrHtml);

/* Dark-scheme variant of the same document — the palette the
   in-app preview modal shows when the user toggles Dark. Paper
   output is always light; this is purely for eyeballing.
   (Non-dark samples pin data-scheme="light" so the embedded
   bootstrap script can't flip them to the dev machine's OS theme.) */
const withDarkScheme = (html: string): string => html.replace("<html ", '<html data-scheme="dark" ');
const withLightScheme = (html: string): string => html.replace(/\s*data-scheme="[^"]*"/, "");
writeSample("sales-report-print.html", withLightScheme(ltrHtml));
writeSample("sales-report-print-dark.html", withDarkScheme(ltrHtml));

/* ═══ 3. A4 report — RTL / Urdu ════════════════════════════════ */

const urduProducts = [
  { name: "کوکا کلاسک 1.5 لیٹر", sku: "BEV-0001", qty: "412", revenue: "7,416.00" },
  { name: "باسمتی چاول 5 کلو", sku: "GRN-0042", qty: "128.5", revenue: "10,982.50" },
  { name: "سرف ایکسل 1 کلو", sku: "HHD-0117", qty: "96", revenue: "3,830.04" },
  { name: "لیپٹن یلو لیبل 450 گرام", sku: "BEV-0388", qty: "88", revenue: "2,631.12" },
  { name: "دلدا ککنگ آئل 5 لیٹر", sku: "GRN-0101", qty: "74", revenue: "8,140.00" },
];

const rtlHtml = buildReportHtml(
  {
    title: "سیلز رپورٹ",
    kicker: "فروخت کا تجزیہ",
    periodLabel: "24 اگست ← 23 ستمبر 2026",
    reference: "RPT-SLS-2026-0923",
    kpis: [
      { label: "کل آمدنی", value: "Rs 59,110.81", tone: "positive" },
      { label: "خالص آمدنی", value: "Rs 56,135.27" },
      { label: "کل آرڈرز", value: "1,253" },
      { label: "اوسط آرڈر", value: "Rs 4,717.00", tone: "warning" },
    ],
    sections: [
      {
        title: "مقبول مصنوعات",
        columns: [
          { label: "پروڈکٹ", strong: true, value: (p: (typeof urduProducts)[number]) => p.name },
          { label: "SKU", muted: true, value: (p: (typeof urduProducts)[number]) => p.sku },
          { label: "فروخت", align: "right", value: (p: (typeof urduProducts)[number]) => p.qty },
          { label: "آمدنی", align: "right", strong: true, value: (p: (typeof urduProducts)[number]) => p.revenue },
        ],
        rows: urduProducts,
        totalsLabel: "کل",
      },
    ],
    footnote: "تمام رقم پاکستانی روپیہ میں ہے۔ کھاتہ کی بقایا رقم کسٹمر اسٹیٹمنٹ میں منتقل ہوتی ہے۔",
  },
  SETTINGS,
  { rtl: true, generatedAt: GENERATED_AT }
);
writeSample("sales-report-print-ur.html", withLightScheme(rtlHtml));

/* ═══ 4. Purchase order document ═══════════════════════════════ */

const poHtml = buildPurchaseOrderHtml(
  {
    poNumber: "PO-000142",
    status: "ordered",
    orderDate: "Sep 22, 2026",
    expectedDate: "Oct 1, 2026",
    supplier: {
      name: "Fresh Foods Distribution Ltd",
      phone: "+92 321 9876543",
      email: "orders@freshfoods.example",
      address: "Warehouse 7, Industrial Estate, Karachi",
    },
    createdBy: "Buffy (Store Manager)",
    notes: "Deliver before 10:00 AM. Cold-chain items must arrive at ≤ 4°C — reject otherwise.",
    items: [
      { productName: "Coca-Cola Classic 1.5L", sku: "BEV-0001", quantity: 120, unit: null, unitCost: 14_500, lineTotal: 1_740_000, receivedQty: 0 },
      { productName: "Basmati Rice 5kg Premium", sku: "GRN-0042", quantity: 60, unit: "bag", unitCost: 78_500, lineTotal: 4_710_000, receivedQty: 0 },
      { productName: "Nestlé Nido 900g", sku: "DRY-0230", quantity: 36, unit: null, unitCost: 118_400, lineTotal: 4_262_400, receivedQty: 0 },
      { productName: "K&N's Chicken Nuggets 500g", sku: "FRZ-0055", quantity: 48, unit: null, unitCost: 38_600, lineTotal: 1_852_800, receivedQty: 12 },
    ],
    amountPaid: 2_000_000,
  },
  SETTINGS,
  { rtl: false, generatedAt: GENERATED_AT }
);
writeSample("purchase-order-print.html", withLightScheme(poHtml));
writeSample("purchase-order-print-dark.html", withDarkScheme(poHtml));

/* ═══ 5. Inventory valuation report ════════════════════════════ */

const stockRows = [
  { product: "Basmati Rice 5kg Premium", sku: "GRN-0042", category: "Groceries & Staples", warehouse: "Main Store", qty: "128.5 kg", available: "112 kg", status: "In Stock", value: "100,880.00" },
  { product: "Coca-Cola Classic 1.5L", sku: "BEV-0001", category: "Beverages", warehouse: "Main Store", qty: "214 pcs", available: "198 pcs", status: "In Stock", value: "31,030.00" },
  { product: "Nestlé Nido 900g", sku: "DRY-0230", category: "Dairy & Bakery", warehouse: "Main Store", qty: "18 pcs", available: "15 pcs", status: "Low Stock", value: "21,312.00" },
  { product: "K&N's Chicken Nuggets 500g", sku: "FRZ-0055", category: "Frozen Foods", warehouse: "Cold Room", qty: "0 pcs", available: "0 pcs", status: "Out of Stock", value: "0.00" },
  { product: "Surf Excel 1kg", sku: "HHD-0117", category: "Household Care", warehouse: "Main Store", qty: "76 pcs", available: "70 pcs", status: "In Stock", value: "30,400.00" },
  { product: "Colgate MaxFresh 120g", sku: "PCR-0176", category: "Personal Care", warehouse: "Godown", qty: "5 pcs", available: "5 pcs", status: "Low Stock", value: "895.00" },
];

const invHtml = buildReportHtml(
  {
    title: "Inventory Valuation",
    kicker: "Stock Report",
    reference: "RPT-INV-2026-0923",
    kpis: [
      { label: "Stock Value (Cost)", value: money(1_845_170), tone: "positive" },
      { label: "Retail Value", value: money(2_409_860) },
      { label: "Potential Profit", value: money(564_690), tone: "positive" },
      { label: "Low Stock", value: "2", tone: "warning" },
    ],
    meta: [
      { label: "Products Tracked", value: "615" },
      { label: "Out of Stock", value: "1" },
      { label: "Dead Stock", value: "4" },
    ],
    sections: [
      {
        title: "Stock Levels",
        columns: [
          { label: "Product", width: "26%", strong: true, value: (r: (typeof stockRows)[number]) => r.product },
          { label: "SKU", muted: true, value: (r: (typeof stockRows)[number]) => r.sku },
          { label: "Warehouse", value: (r: (typeof stockRows)[number]) => r.warehouse },
          { label: "Qty", align: "right", value: (r: (typeof stockRows)[number]) => r.qty },
          { label: "Available", align: "right", muted: true, value: (r: (typeof stockRows)[number]) => r.available },
          { label: "Status", align: "center", value: (r: (typeof stockRows)[number]) => r.status },
          { label: "Stock Value", align: "right", strong: true, value: (r: (typeof stockRows)[number]) => r.value, total: () => money(1_845_170) },
        ],
        rows: stockRows,
        totalsLabel: "Total Stock Value",
      },
    ],
    footnote: "Valued at latest cost price. Dead stock = no sales in 90 days.",
  },
  SETTINGS,
  { rtl: false, generatedAt: GENERATED_AT }
);
writeSample("inventory-report-print.html", withLightScheme(invHtml));

console.log("\nDone. Open samples/ and print-preview the HTML files (Ctrl+P).");
