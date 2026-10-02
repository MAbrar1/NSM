/* ═══════════════════════════════════════════════════════════════
   CHART LAYOUT — pure tick/label math for the SVG charts.

   Everything here is deterministic and DOM-free: the components
   inject a text-measure function (canvas in the browser, a
   conservative estimate on the server), so every geometry decision
   is unit-testable.

   The invariant this module is built around: a chart label is never
   truncated. When text does not fit its slot the layout wraps it,
   steps it, or scrolls the plot — the full string always survives
   (on screen, in a <title>, and in the hover tooltip).
   ═══════════════════════════════════════════════════════════════ */

/* ─── Axis ticks ─── */

export interface TickPlan {
  /** Ascending tick values — integers, all ≥ 1. */
  ticks: number[];
  /** Scale maximum; ≥ maxValue so the tallest bar stays under the top tick. */
  niceMax: number;
}

/** "Nice" axis ticks at 1 / 2 / 2.5 / 5 × 10^k steps.
 *
 *  maxValue is in the same integer unit the chart draws (cents for
 *  money), so every tick is a whole number — a quarter of 12345 used
 *  to render an axis label like "3,086.25". */
export function niceTicks(maxValue: number, targetCount = 4): TickPlan {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { ticks: [], niceMax: 1 };

  const rough = Math.max(1, maxValue) / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const multiple = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  // Whole units only — cents are integers, and fractional steps round
  // to duplicate ticks.
  const step = Math.max(1, Math.ceil(multiple * magnitude));
  const niceMax = Math.ceil(maxValue / step) * step;

  const ticks: number[] = [];
  for (let v = step; v <= niceMax; v += step) ticks.push(Math.round(v));
  return { ticks, niceMax };
}

/* ─── X-axis labels ─── */

/** Wrap a label onto at most `maxLines` lines at word boundaries.
 *
 *  Never splits a word and never drops one: when even the last line
 *  overflows, the line keeps the remaining words whole (the caller's
 *  step/scroll logic then widens the slot until it fits). The joined
 *  lines always reconstruct the original label. */
export function wrapLabel(
  label: string,
  maxWidth: number,
  measure: (text: string) => number,
  maxLines = 2
): string[] {
  const words = label.trim().split(/\s+/);
  if (words.length <= 1 || maxLines <= 1) return [label];
  if (measure(label) <= maxWidth) return [label];

  const lines: string[] = [];
  let current = words[0]!;
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    // Keep appending once the line budget is spent so no word is lost.
    if (measure(candidate) <= maxWidth || lines.length === maxLines - 1) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i]!;
    }
  }
  lines.push(current);
  return lines;
}

export interface XLabelPlan {
  /** Show every `step`-th label (1 = all of them). */
  step: number;
  /** Wrapped lines per label, or null when labels stay single-line. */
  lines: string[][] | null;
  /** True when every label fits its own slot at step 1. */
  allFit: boolean;
}

export interface XLabelOptions {
  /** Try wrapping long multi-word labels before stepping them. */
  allowWrap?: boolean;
  /** Upper bound on how many labels may render (density guard). */
  maxLabelCount?: number;
  /** Breathing room between neighbouring labels. */
  padding?: number;
  maxLines?: number;
}

/** Decide how to render x-axis labels inside slots of `slotWidth` px.
 *
 *  Order of preference: show all → wrap (multi-word, ≤ 2 lines) →
 *  step every k-th label. The returned step always guarantees
 *  `step * slotWidth ≥ widest label + padding`, so two rendered
 *  labels can never collide — and nothing is ever cut. */
export function planXLabels(
  labels: string[],
  slotWidth: number,
  measure: (text: string) => number,
  options: XLabelOptions = {}
): XLabelPlan {
  const { allowWrap = true, maxLabelCount = 24, padding = 6, maxLines = 2 } = options;
  if (labels.length === 0) return { step: 1, lines: null, allFit: true };

  const safeSlot = Math.max(1, slotWidth);
  const available = Math.max(1, safeSlot - padding);

  let lines: string[][] | null = null;
  let widest = Math.max(0, ...labels.map((l) => measure(l)));

  if (allowWrap && widest > available) {
    const wrapped = labels.map((l) => wrapLabel(l, available, measure, maxLines));
    if (wrapped.some((w) => w.length > 1)) {
      lines = wrapped;
      widest = Math.max(0, ...wrapped.flat().map((l) => measure(l)));
    }
  }

  const stepForWidth = Math.max(1, Math.ceil((widest + padding) / safeSlot));
  const stepForDensity = Math.max(1, Math.ceil(labels.length / Math.max(1, maxLabelCount)));
  const step = Math.max(stepForWidth, stepForDensity);
  return { step, lines, allFit: step === 1 };
}

/** Pick which label indices render when stepping by `step`.
 *
 *  Always includes the first and last label (the axis edges carry the
 *  range), and drops the second-to-last pick when it would crowd the
 *  final one. */
export function selectLabelIndices(count: number, step: number): number[] {
  if (count <= 0) return [];
  if (step <= 1) return Array.from({ length: count }, (_, i) => i);

  const indices: number[] = [];
  for (let i = 0; i < count; i += step) indices.push(i);

  const last = count - 1;
  if (indices[indices.length - 1] !== last) {
    const previous = indices[indices.length - 1]!;
    if (indices.length > 1 && last - previous <= Math.floor(step / 2)) indices.pop();
    indices.push(last);
  }
  return indices;
}
