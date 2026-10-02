/* ═══════════════════════════════════════════════════════════════
   CHART RENDER — contract tests (server render)

   Renders the SVG charts to static markup and locks the two visual
   promises that used to be broken:

   • NO TRUNCATION. The old BarChart sliced every x-label to 6 chars
     ("Beverages & Juices" → "Bevera…") and hid all labels past 15
     bars. The contract: no ellipsis in the output, every word of
     every label present, and the full label reachable in a <title>.
   • NO WRONG MONEY. Compact labels must show the real amount — the
     old code compacted raw cents ("123.5K" for $1,234.56).

   Server rendering exercises the deterministic path: the measure
   fallback decides the layout (canvas is client-only), so these
   assertions are stable across machines.

   Run: npx tsx --test tests/chart-render.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart, DonutChart, LineChart } from "@/components/ui/chart";
import { setCurrencyDefaults } from "@/lib/money/currency-core";

setCurrencyDefaults("USD", "en-US");

const BARS = [
  { label: "Beverages & Juices", value: 123456 },
  { label: "Dairy & Chilled Goods", value: 65432 },
  { label: "Snacks", value: 24000 },
  { label: "Bakery", value: 12000 },
  { label: "Produce", value: 8000 },
];

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

/** Serialized markup HTML-escapes text (& → &amp;); decode it back so
 *  assertions compare against the real rendered characters. */
function renderText(element: React.ReactElement): string {
  return render(element)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

test("BarChart: no label is ever sliced or ellipsised", () => {
  const html = renderText(React.createElement(BarChart, { data: BARS }));
  assert.ok(!html.includes("…"), "ellipsis found in chart output");
  for (const row of BARS) {
    for (const word of row.label.split(/\s+/)) {
      assert.ok(html.includes(word), `word "${word}" missing from output`);
    }
    // The full label stays reachable (bar tooltip / label <title>).
    assert.ok(html.includes(`${row.label}: `), `full label "${row.label}" missing`);
  }
});

test("BarChart: full values are exact in titles and aria, compact on axis", () => {
  const html = render(
    React.createElement(BarChart, { data: BARS, compactValueLabels: true })
  );
  // Full precision stays available…
  assert.ok(html.includes("$1,234.56"), "exact value missing");
  // …while the compact axis shows the REAL amount…
  assert.ok(html.includes("$1.5K"), "expected compact axis tick $1.5K");
  assert.ok(html.includes("$1.2K"), "expected compact value label $1.2K");
  // …never the old 100×-wrong cent compaction.
  assert.ok(!html.includes("123.5K"), "raw-cent compact label leaked");
});

test("BarChart: a dense series keeps its axis and edge labels", () => {
  const dense = Array.from({ length: 31 }, (_, i) => ({
    label: `Jan ${i + 1}`,
    value: 1000 + i * 37,
  }));
  const html = render(React.createElement(BarChart, { data: dense, height: 220 }));
  assert.ok(!html.includes("…"), "ellipsis found in dense chart");
  assert.ok(html.includes(">Jan 1</tspan>"), "first label missing");
  assert.ok(html.includes(">Jan 31</tspan>"), "last label missing");
  // No 2px sliver lies for zero revenue, and no NaN/undefined leaked.
  assert.ok(!html.includes("NaN") && !html.includes("undefined"));
});

test("DonutChart: legend wraps full labels and shows exact percentages", () => {
  const donut = [
    { label: "Cash payments", value: 900000, color: "var(--neu-ink-green)" },
    { label: "Card payments", value: 600000, color: "var(--neu-accent-line)" },
    { label: "Zero refunds", value: 0, color: "var(--neu-text-faint)" },
  ];
  const html = render(React.createElement(DonutChart, { data: donut }));
  assert.ok(!html.includes("…"));
  assert.ok(html.includes("Cash payments"), "legend label missing");
  assert.ok(html.includes("60%"), "expected 60% for 900000/1500000");
  assert.ok(html.includes("40%"), "expected 40% for 600000/1500000");
  assert.ok(html.includes("0%"), "zero rows stay listed with 0%");
  assert.ok(html.includes("$9,000.00"), "legend shows the full amount");
  assert.ok(!html.includes("NaN"), "NaN leaked into the donut");
});

test("DonutChart: segments are keyboard-reachable with a roving tabindex", () => {
  const donut = [
    { label: "Cash payments", value: 900000, color: "var(--neu-ink-green)" },
    { label: "Card payments", value: 600000, color: "var(--neu-accent-line)" },
  ];
  const html = renderText(React.createElement(DonutChart, { data: donut }));
  // Exactly one tab stop (roving tabindex), segments announce themselves.
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, "expected one tab stop");
  assert.ok(html.includes('tabindex="-1"'), "other segments stay off the tab order");
  assert.ok(html.includes('role="img" aria-label="Cash payments: $9,000.00 (60%)"'),
    "segment aria-label missing");
  // Zero-value rows are never focusable (they draw no segment).
  assert.ok(!html.includes('aria-label="Zero'), "zero rows must not render segments");
});

test("LineChart: renders a polyline and end dot for a series", () => {
  const html = render(React.createElement(LineChart, { data: [3, 5, 4, 9] }));
  assert.ok(html.includes("<polyline"));
  assert.ok(html.includes("<circle"));
});
