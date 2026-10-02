/* ═══════════════════════════════════════════════════════════════
   CHART LAYOUT — unit tests

   Locks the geometry contract of the SVG charts
   (src/lib/charts/layout.ts) and the chart label formatter:

   • Axis ticks are whole "nice" numbers (1/2/2.5/5 steps) — the old
     [0.25, 0.5, 0.75, 1] × max axis rendered labels like "3,086.25".
   • A label is never truncated: wrapping preserves every word, and
     the chosen step guarantees two shown labels cannot collide.
   • formatCurrencyCompact labels the REAL amount — formatting raw
     cents with a bare compact formatter was 100× wrong ("123.5K"
     for $1,234.56), and compact notation must not round $9.99 to
     "$10" either.

   Run: npx tsx --test tests/chart-layout.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  niceTicks,
  planXLabels,
  selectLabelIndices,
  wrapLabel,
} from "@/lib/charts/layout";
import { formatCurrencyCompact, setCurrencyDefaults } from "@/lib/money/currency-core";

/** Deterministic stand-in for canvas measureText: 10px per character. */
const measure10 = (s: string) => s.length * 10;

/* ─── niceTicks ─── */

test("niceTicks: round steps at or above the maximum", () => {
  const { ticks, niceMax } = niceTicks(123456, 4);
  assert.equal(niceMax, 150000);
  assert.deepEqual(ticks, [50000, 100000, 150000]);
});

test("niceTicks: an exact max stays exact", () => {
  assert.deepEqual(niceTicks(100, 4), { ticks: [25, 50, 75, 100], niceMax: 100 });
});

test("niceTicks: ticks are whole, unique, ascending and end at niceMax", () => {
  for (const max of [1, 2, 3, 7, 99, 250, 3086, 999999]) {
    const { ticks, niceMax } = niceTicks(max, 4);
    assert.ok(niceMax >= max, `niceMax ${niceMax} < ${max}`);
    assert.ok(ticks.length >= 1 && ticks.length <= 6, `tick count ${ticks.length}`);
    for (const t of ticks) {
      assert.ok(Number.isInteger(t), `fractional tick ${t}`);
      assert.ok(t >= 1 && t <= niceMax);
    }
    assert.equal(new Set(ticks).size, ticks.length, "duplicate ticks");
    assert.equal(ticks[ticks.length - 1], niceMax);
  }
});

test("niceTicks: empty axis for zero/negative/non-finite maxima", () => {
  for (const max of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(niceTicks(max, 4), { ticks: [], niceMax: 1 });
  }
});

/* ─── wrapLabel ─── */

test("wrapLabel: wrapping never drops, splits or reorders words", () => {
  const label = "Beverages & Juices Monthly Sale";
  for (const width of [300, 200, 120, 60, 25]) {
    const lines = wrapLabel(label, width, measure10, 2);
    assert.ok(lines.length <= 2);
    assert.equal(lines.join(" ").replace(/\s+/g, " "), label);
    for (const line of lines) {
      for (const word of line.split(" ")) assert.ok(label.includes(word), `lost word ${word}`);
    }
  }
});

test("wrapLabel: a single word is returned whole, never split", () => {
  assert.deepEqual(wrapLabel("Refrigerators", 40, measure10, 2), ["Refrigerators"]);
});

test("wrapLabel: short labels pass through untouched", () => {
  assert.deepEqual(wrapLabel("Mon", 100, measure10, 2), ["Mon"]);
});

/* ─── planXLabels ─── */

test("planXLabels: labels that fit keep step 1 and no wrapping", () => {
  const plan = planXLabels(["Mon", "Tue", "Wed"], 200, measure10);
  assert.equal(plan.step, 1);
  assert.equal(plan.lines, null);
  assert.ok(plan.allFit);
});

test("planXLabels: long category names wrap instead of being cut", () => {
  const labels = ["Beverages & Juices", "Dairy & Chilled Goods"];
  const plan = planXLabels(labels, 120, measure10, { allowWrap: true });
  assert.ok(plan.lines !== null, "expected wrapping");
  labels.forEach((label, i) => {
    assert.equal(plan.lines![i]!.join(" ").replace(/\s+/g, " "), label);
  });
  // The chosen step still guarantees shown labels cannot collide.
  const widest = Math.max(...plan.lines!.flat().map(measure10));
  assert.ok(plan.step * 120 >= widest, `step ${plan.step} too small for ${widest}px`);
});

test("planXLabels: steps single long words that cannot wrap", () => {
  const plan = planXLabels(["Refrigerators", "Airconditioners", "Microwaveovens"], 60, measure10);
  const widest = 16 * 10; // "Airconditioners"
  assert.ok(plan.step * 60 >= widest, `step ${plan.step} too small for ${widest}px`);
});

test("planXLabels: density guard caps how many labels can render", () => {
  const labels = Array.from({ length: 365 }, (_, i) => `D${i}`);
  const plan = planXLabels(labels, 400, measure10, { maxLabelCount: 24 });
  assert.ok(Math.ceil(labels.length / plan.step) <= 25, `step ${plan.step} renders too many`);
});

/* ─── selectLabelIndices ─── */

test("selectLabelIndices: step 1 selects everything, single label included", () => {
  assert.deepEqual(selectLabelIndices(5, 1), [0, 1, 2, 3, 4]);
  assert.deepEqual(selectLabelIndices(1, 2), [0]);
  assert.deepEqual(selectLabelIndices(0, 3), []);
});

test("selectLabelIndices: keeps both edges and avoids crowding the last label", () => {
  const idx = selectLabelIndices(30, 4);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], 29);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i]! - idx[i - 1]! >= Math.ceil(2 / 1) * 2 || idx[i]! - idx[i - 1]! >= 2);
  }
  // Never crowds: the gap before the final edge pick is at least half a step.
  const gap = idx[idx.length - 1]! - idx[idx.length - 2]!;
  assert.ok(gap >= 2, `edge labels crowded (gap ${gap})`);
});

/* ─── formatCurrencyCompact ─── */

setCurrencyDefaults("USD", "en-US");

test("formatCurrencyCompact: labels the real amount, not the raw cent count", () => {
  // The old chart bug: compactNumber.format(123456 cents) → "123.5K",
  // 100× the actual $1,234.56.
  assert.equal(formatCurrencyCompact(123456), "$1.2K");
  assert.notEqual(formatCurrencyCompact(123456), "123.5K");
  assert.equal(formatCurrencyCompact(1250000), "$12.5K");
  assert.equal(formatCurrencyCompact(150000000), "$1.5M");
});

test("formatCurrencyCompact: exact below the compact threshold", () => {
  assert.equal(formatCurrencyCompact(999), "$9.99"); // never rounded to "$10"
  assert.equal(formatCurrencyCompact(50000), "$500");
  assert.equal(formatCurrencyCompact(0), "$0");
});

test("formatCurrencyCompact: non-finite input renders zero, never NaN text", () => {
  assert.equal(formatCurrencyCompact(Number.NaN), "$0");
  assert.equal(formatCurrencyCompact(Number.POSITIVE_INFINITY), "$0");
});
