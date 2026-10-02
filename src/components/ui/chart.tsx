"use client";

import * as React from "react";
import { cn, formatCurrency, formatCurrencyCompact } from "@/lib/utils";
import { useI18n } from "@/components/providers/i18n-provider";
import { niceTicks, planXLabels, selectLabelIndices } from "@/lib/charts/layout";

/* ═══════════════════════════════════════════════════════════════
   CHART COMPONENTS
   Lightweight SVG charts. No external charting library needed.

   Layout contract — why this file measures before it draws:
   • The plot is measured with a ResizeObserver and rendered in real
     CSS pixels (explicit width/height, no viewBox scaling), so SVG
     text is never stretched, shrunk or distorted by the container.
   • A label is NEVER truncated. When x-labels do not fit their slot
     they wrap (≤ 2 lines), then step, then the plot scrolls — the
     full string stays on screen and in the hover tooltip.
   • Dense series (30+ buckets) scroll horizontally; the y-axis
     gutter is a separate sticky column that never scrolls away.
   • Money labels go through formatCurrency / formatCurrencyCompact,
     so compact axis text ("Rs 1.2K") and the full tooltip value
     always agree on the unit.
   ═══════════════════════════════════════════════════════════════ */

// ─── Shared layout constants ───
const MIN_SLOT = 20; // px per bar below which the plot scrolls
const MAX_BAR_W = 56; // px cap so few-bar charts stay elegant
const BAR_GAP = 6; // px between bars inside a slot
const GUTTER_MIN = 34;
const GUTTER_MAX = 140;
const PLOT_TOP = 16; // head-room for the tallest bar's value label
const MAX_VISIBLE_X_LABELS = 24;
const TOOLTIP_MAX_W = 240;
const SCROLLBAR_RESERVE = 14; // px stolen by a horizontal scrollbar
const AVG_MIN_BARS = 3; // the mean line needs at least a few bars to mean anything

/** Compact plain-number formatter for sparkline min/max labels (non-money). */
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

/* ─── Text measurement ───
   Canvas measureText when a DOM exists; a deliberately wide per-char
   estimate on the server. Over-measuring gives a label more room —
   under-measuring would clip it, which this module forbids. */
function estimateTextWidth(text: string, weight: number, size: number): number {
  const wide = /[^\u0000-\u007f]/.test(text); // Arabic/Urdu glyphs run wider
  return text.length * size * (wide ? 0.62 : 0.56) * (weight >= 600 ? 1.04 : 1) + 2;
}

function useTextMeasure(): (text: string, weight?: number, size?: number) => number {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const cacheRef = React.useRef(new Map<string, number>());

  return React.useCallback((text: string, weight = 400, size = 12) => {
    const key = `${weight}|${size}|${text}`;
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) return cached;

    let width: number;
    if (typeof document === "undefined") {
      width = estimateTextWidth(text, weight, size);
    } else {
      const canvas = (canvasRef.current ??= document.createElement("canvas"));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        width = estimateTextWidth(text, weight, size);
      } else {
        ctx.font = `${weight} ${size}px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif`;
        width = ctx.measureText(text).width;
      }
    }
    cacheRef.current.set(key, width);
    return width;
  }, []);
}

/** Bar with rounded top corners only — grounded on the baseline. */
function roundedTopRect(x: number, y: number, w: number, h: number): string {
  const r = Math.max(0, Math.min(5, w / 2, h));
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + r}`,
    r > 0 ? `Q ${x} ${y} ${x + r} ${y}` : `L ${x} ${y}`,
    `L ${x + w - r} ${y}`,
    r > 0 ? `Q ${x + w} ${y} ${x + w} ${y + r}` : `L ${x + w} ${y}`,
    `L ${x + w} ${y + h}`,
    "Z",
  ].join(" ");
}

// ─── Bar Chart ───
// Rows may carry extra metadata (e.g. a raw month key) for drill-down.
// An optional numeric `orders` per row is shown in the tooltip next to
// the value ("Rs 1,234.56 · 7 orders") when present.
type BarRow = { label: string; value: number; [key: string]: unknown };

interface BarChartProps {
  data: BarRow[];
  height?: number;
  color?: string;
  formatValue?: (v: number) => string;
  /** Show compact values (12.3K) atop bars/axis instead of full currency. */
  compactValueLabels?: boolean;
  /** Fill the parent's height instead of a fixed pixel height — for cards
   *  that stretch in a grid row. The parent must have a real height. */
  fillHeight?: boolean;
  /** Draw a dashed mean guide across the plot (right-edge mini label). */
  showAverage?: boolean;
  /** 24-slot hour series: labels get sparser (every other hour reads fine).
   *  The tooltip always shows the full label for skipped slots. */
  sparseLabels?: boolean;
  onBarClick?: (entry: BarRow) => void;
  className?: string;
}

export function BarChart({
  data,
  height = 200,
  color = "var(--neu-accent-line)",
  formatValue = formatCurrency,
  compactValueLabels = false,
  fillHeight = false,
  showAverage = false,
  sparseLabels = false,
  onBarClick,
  className,
}: BarChartProps) {
  const { t } = useI18n();
  const measure = useTextMeasure();
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [containerHeight, setContainerHeight] = React.useState(0);
  const [hover, setHover] = React.useState<number | null>(null);
  const gradientId = React.useId().replace(/:/g, "");

  useIsomorphicLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      setContainerWidth(el.clientWidth);
      setContainerHeight(el.clientHeight);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A range/length change invalidates which bar the pointer was over.
  React.useEffect(() => {
    setHover(null);
  }, [data.length]);

  const plan = React.useMemo(() => {
    if (data.length === 0) return null;
    const n = data.length;
    const formatLabel = (v: number) =>
      compactValueLabels ? formatCurrencyCompact(v) : formatValue(v);

    const maxVal = data.reduce((m, d) => (Number.isFinite(d.value) ? Math.max(m, d.value) : m), 0);
    const peakIndex = data.reduce((best, d, i) => (d.value > data[best]!.value ? i : best), 0);
    const positive = data.filter((d) => Number.isFinite(d.value) && d.value > 0);
    const mean = positive.length > 0 ? positive.reduce((s, d) => s + d.value, 0) / positive.length : 0;
    const drawAverage = showAverage && n >= AVG_MIN_BARS && positive.length > 0 && mean > 0 && mean < maxVal;
    const { ticks, niceMax } = niceTicks(maxVal, 4);
    const scaleMax = Math.max(1, niceMax);

    // The gutter is sized from the widest tick label so y-axis money
    // text can never be clipped by the plot edge.
    const tickLabels = ticks.map(formatLabel);
    const gutter = Math.min(
      GUTTER_MAX,
      Math.max(GUTTER_MIN, (tickLabels.length > 0 ? Math.max(...tickLabels.map((l) => measure(l))) : 0) + 12)
    );

    const width = containerWidth || 640; // SSR / pre-measure fallback
    const plotViewport = Math.max(80, width - gutter);
    const slot = Math.max(MIN_SLOT, plotViewport / n);
    const plotW = Math.max(plotViewport, n * MIN_SLOT);
    const scrolls = plotW > plotViewport + 1;

    // Fluid mode: take the card's measured height (minus a scrollbar
    // reserve) so the chart fills the grid row with no dead space.
    const svgHeight = fillHeight
      ? Math.max(120, (containerHeight || height) - (scrolls ? SCROLLBAR_RESERVE : 0))
      : height + (scrolls ? SCROLLBAR_RESERVE : 0);

    const xPlan = planXLabels(
      data.map((d) => d.label),
      slot,
      (t) => measure(t),
      {
        allowWrap: n <= 16,
        maxLabelCount: sparseLabels ? 12 : MAX_VISIBLE_X_LABELS,
        padding: sparseLabels ? 10 : 6,
      }
    );
    const shownLabels = new Set(selectLabelIndices(n, xPlan.step));

    const xAxisH = xPlan.lines ? 32 : 20;
    const plotBottom = svgHeight - xAxisH;
    const plotH = Math.max(10, plotBottom - PLOT_TOP);
    const barW = Math.min(MAX_BAR_W, Math.max(4, slot - BAR_GAP));

    // Value labels are all-or-nothing: a label must fit its own slot.
    const valueLabelsFit =
      n <= 80 &&
      data.reduce((w, d) => (d.value > 0 ? Math.max(w, measure(formatLabel(d.value), 600)) : w), 0) + 8 <=
        slot;

    const ariaLabel =
      n <= 20
        ? data.map((d) => `${d.label}: ${formatValue(d.value)}`).join(", ")
        : `Bar chart with ${n} points, from ${data[0]!.label} to ${data[n - 1]!.label}`;

    const avgLabel = drawAverage ? formatLabel(mean) : null;
    const ariaLabelFull =
      (n <= 20
        ? data.map((d) => `${d.label}: ${formatValue(d.value)}`).join(", ")
        : `Bar chart with ${n} points, from ${data[0]!.label} to ${data[n - 1]!.label}`) +
      (avgLabel ? `. Average ${avgLabel}.` : "");

    return {
      n,
      formatLabel,
      ticks,
      scaleMax,
      gutter,
      slot,
      plotW,
      scrolls,
      xPlan,
      shownLabels,
      plotBottom,
      plotH,
      barW,
      valueLabelsFit,
      svgHeight,
      peakIndex,
      drawAverage,
      mean,
      avgLabel,
      ariaLabel: ariaLabelFull,
      width,
    };
  }, [data, containerWidth, containerHeight, height, compactValueLabels, formatValue, measure, fillHeight, showAverage, sparseLabels]);

  if (data.length === 0)
    return <EmptyChart height={height} fill={fillHeight} className={className} />;
  const p = plan!;

  const hoveredRow = hover !== null ? data[hover] : undefined;
  const hoveredOrders =
    hoveredRow && typeof hoveredRow["orders"] === "number" && Number.isFinite(hoveredRow["orders"])
      ? (hoveredRow["orders"] as number)
      : null;
  const tooltipLine2 =
    hoveredRow === undefined
      ? ""
      : hoveredOrders === null
        ? formatValue(hoveredRow.value)
        : `${formatValue(hoveredRow.value)} · ${hoveredOrders} ${t("dashboard.orders")}`;
  const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
  const tipWidth = Math.min(TOOLTIP_MAX_W, Math.max(120, p.width - 16));
  const tipHalf = tipWidth / 2 + 4;
  const tipLeft =
    hover !== null
      ? Math.min(
          Math.max(p.gutter + hover * p.slot + p.slot / 2 - scrollLeft, tipHalf),
          Math.max(tipHalf, p.width - tipHalf)
        )
      : 0;
  const hoverBarH =
    hoveredRow && hoveredRow.value > 0 ? Math.max(2, (p.plotH * hoveredRow.value) / p.scaleMax) : 0;
  const hoverBarTop = p.plotBottom - hoverBarH;
  const tipAbove = hoverBarTop > 84;
  const yFor = (value: number) => p.plotBottom - (p.plotH * value) / p.scaleMax;

  return (
    <div ref={wrapRef} className={cn("relative flex", className)}>
      {/* Sticky y-axis gutter — never scrolls with the plot */}
      <svg width={p.gutter} height={p.svgHeight} aria-hidden className="shrink-0">
        {p.ticks.map((tick) => (
          <text
            key={tick}
            x={p.gutter - 8}
            y={yFor(tick) + 4}
            textAnchor="end"
            className="neu-chart-axis"
          >
            {p.formatLabel(tick)}
          </text>
        ))}
      </svg>

      {/* Scrolling plot */}
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:thin]"
        style={{ height: p.svgHeight }}
        onScroll={() => setHover(null)}
      >
        <svg
          width={p.plotW}
          height={p.svgHeight}
          role={onBarClick ? "group" : "img"}
          aria-label={p.ariaLabel}
        >
          {/* Vertical ink gradient — bars get depth without leaving the
              token system (top = full color, bottom = soft wash). */}
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} />
              <stop offset="100%" stopColor={color} stopOpacity={0.3} />
            </linearGradient>
          </defs>
          {/* Grid lines + baseline (horizontal — unaffected by scrolling) */}
          {p.ticks.map((tick) => (
            <line
              key={tick}
              x1={0}
              x2={p.plotW}
              y1={yFor(tick)}
              y2={yFor(tick)}
              className="neu-chart-grid"
              strokeDasharray="4"
              aria-hidden
            />
          ))}
          <line
            x1={0}
            x2={p.plotW}
            y1={p.plotBottom}
            y2={p.plotBottom}
            className="neu-chart-baseline"
            aria-hidden
          />

          {/* Mean guide — dashed line + compact label at the right edge.
              Answers "is this bar above or below average?" at a glance. */}
          {p.drawAverage && (
            <g aria-hidden className="fade-in-30">
              <line
                x1={0}
                x2={p.plotW}
                y1={yFor(p.mean)}
                y2={yFor(p.mean)}
                stroke={color}
                strokeWidth={1}
                strokeDasharray="2 4"
                opacity={0.55}
              />
              <text
                x={p.plotW - 4}
                y={yFor(p.mean) - 4}
                textAnchor="end"
                fontWeight={600}
                className="neu-chart-axis"
              >
                {p.avgLabel}
              </text>
            </g>
          )}

          {data.map((d, i) => {
            const slotX = i * p.slot;
            const cx = slotX + p.slot / 2;
            const barH = d.value > 0 ? Math.max(2, (p.plotH * d.value) / p.scaleMax) : 0;
            const barX = cx - p.barW / 2;
            const barY = p.plotBottom - barH;
            const isHovered = hover === i;
            const valueText = d.value > 0 ? p.formatLabel(d.value) : "";
            const lines = p.xPlan.lines?.[i] ?? [d.label];

            return (
              <g key={i}>
                {isHovered && (
                  <rect
                    x={slotX + 1}
                    y={PLOT_TOP - 6}
                    width={Math.max(2, p.slot - 2)}
                    height={p.plotH + 6}
                    rx={8}
                    fill={color}
                    opacity={0.08}
                    aria-hidden
                  />
                )}
                {barH > 0 && (
                  <path
                    d={roundedTopRect(barX, barY, p.barW, barH)}
                    fill={`url(#${gradientId})`}
                    stroke={color}
                    strokeWidth={1}
                    className="neu-chart-bar-enter transition-opacity duration-150"
                    style={{ animationDelay: `${Math.min(i * 24, 360)}ms` }}
                    opacity={hover === null || isHovered ? 1 : 0.5}
                    aria-hidden
                  />
                )}
                {/* Peak crown — the max bar gets a solid top cap so the eye
                    lands on the champion first. */}
                {i === p.peakIndex && barH >= 12 && (
                  <rect
                    x={barX}
                    y={barY}
                    width={p.barW}
                    height={3}
                    rx={1.5}
                    fill={color}
                    aria-hidden
                  />
                )}
                {p.valueLabelsFit && valueText && (
                  <text
                    x={cx}
                    y={barY - 5}
                    textAnchor="middle"
                    fontWeight={600}
                    className="neu-chart-axis"
                    aria-hidden
                  >
                    {valueText}
                  </text>
                )}
                {p.shownLabels.has(i) && (
                  <text x={cx} y={p.plotBottom + 13} textAnchor="middle" className="neu-chart-axis">
                    <title>{d.label}</title>
                    {lines.map((line, li) => (
                      <tspan key={li} x={cx} dy={li === 0 ? 0 : 12}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                )}
                {/* Full-slot hover/click target — works even for zero bars */}
                <rect
                  x={slotX}
                  y={PLOT_TOP}
                  width={p.slot}
                  height={p.plotH + 8}
                  fill="transparent"
                  pointerEvents="all"
                  className={cn("neu-focus", onBarClick && "cursor-pointer")}
                  role={onBarClick ? "button" : undefined}
                  tabIndex={onBarClick ? 0 : undefined}
                  aria-label={
                    onBarClick
                      ? `${d.label}: ${
                          typeof d["orders"] === "number" && Number.isFinite(d["orders"])
                            ? `${formatValue(d.value)} · ${d["orders"]} orders`
                            : formatValue(d.value)
                        }`
                      : undefined
                  }
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                  onFocus={onBarClick ? () => setHover(i) : undefined}
                  onBlur={onBarClick ? () => setHover((h) => (h === i ? null : h)) : undefined}
                  onClick={onBarClick ? () => onBarClick(d) : undefined}
                  onKeyDown={
                    onBarClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onBarClick(d);
                          }
                        }
                      : undefined
                  }
                >
                  <title>{`${d.label}: ${
                    typeof d["orders"] === "number" && Number.isFinite(d["orders"])
                      ? `${formatValue(d.value)} · ${d["orders"]} orders`
                      : formatValue(d.value)
                  }`}</title>
                </rect>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Tooltip — anchored to the hovered/focused bar, clamped in-view */}
      {hoveredRow && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: tipLeft,
            top: tipAbove ? hoverBarTop - 8 : hoverBarTop + 10,
            transform: tipAbove ? "translate(-50%, -100%)" : "translate(-50%, 0)",
          }}
          aria-hidden
        >
          <div
            className="neu-elevated rounded-[var(--neu-radius-md)] bg-neu-bg px-2.5 py-1.5"
            style={{ maxWidth: TOOLTIP_MAX_W }}
          >
            <p className="break-words text-xs font-semibold leading-4 text-neu-primary">
              {hoveredRow.label}
            </p>
            <p className="mt-0.5 text-xs tabular-nums leading-4 text-neu-muted">{tooltipLine2}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Human-friendly "YYYY-MM" → month start/end local YYYY-MM-DD dates for
 *  drill-down links. Built from local date parts (never toISOString()) so
 *  UTC-negative timezones don't shift the window to the previous day —
 *  the receiving API parses these at local midnight. */
export function monthRange(ym: string): { from: string; to: string } | null {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0); // last day of the month
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: day(start), to: day(end) };
}

// ─── Donut Chart ───
interface DonutChartProps {
  data: Array<{ label: string; value: number; color: string }>;
  size?: number;
  className?: string;
  /** Custom center content instead of the currency total (e.g. a count). */
  center?: {
    value: string;
    label: string;
  };
  /** Render the side legend (default true). Pages that already list the
   *  values in their own table turn it off to avoid saying everything twice. */
  legend?: boolean;
}

const DONUT_GAP_DEG = 1; // visual separation between segments
const DONUT_POP = 3; // px a hovered segment lifts outwards

export function DonutChart({ data, size = 160, className, center, legend = true }: DonutChartProps) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = React.useState<number | null>(null); // data index
  const [tip, setTip] = React.useState<{ x: number; y: number; above: boolean } | null>(null);
  // Roving tabindex over the segments — one tab stop, arrow keys walk them.
  const [focusIndex, setFocusIndex] = React.useState(0);
  const arcRefs = React.useRef<Array<SVGPathElement | null>>([]);
  const measure = useTextMeasure();

  const percent = React.useMemo(
    () => new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }),
    []
  );

  const positive = data.filter((d) => Number.isFinite(d.value) && d.value > 0);
  const total = positive.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) return <EmptyChart height={size} className={className} />;

  const radius = size / 2 - 10;
  const innerRadius = radius * 0.6;
  const cx = size / 2;
  const cy = size / 2;
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;

  // Angular gap instead of a stroke, so segments read cleanly on any
  // background (cards, sunken wells, Golden theme).
  const gapDeg = positive.length > 1 ? DONUT_GAP_DEG : 0;
  let cursor = 0;
  const arcs = data.flatMap((item, dataIndex) => {
    if (!Number.isFinite(item.value) || item.value <= 0) return [];
    const sweep = (item.value / total) * 360;
    const start = cursor + gapDeg / 2;
    cursor += sweep;
    const drawSweep = Math.max(0.6, sweep - gapDeg);
    const mid = start + drawSweep / 2;

    const a0 = toRad(start);
    const a1 = toRad(start + drawSweep);
    const x1 = cx + radius * Math.cos(a0);
    const y1 = cy + radius * Math.sin(a0);
    const x2 = cx + radius * Math.cos(a1);
    const y2 = cy + radius * Math.sin(a1);
    const ix1 = cx + innerRadius * Math.cos(a0);
    const iy1 = cy + innerRadius * Math.sin(a0);
    const ix2 = cx + innerRadius * Math.cos(a1);
    const iy2 = cy + innerRadius * Math.sin(a1);
    const largeArc = drawSweep > 180 ? 1 : 0;

    const path = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix2} ${iy2}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1}`,
      "Z",
    ].join(" ");

    return [{ item, dataIndex, path, mid }];
  });

  const valueTextFor = (value: number) => (center ? String(value) : formatCurrency(value));
  const pctTextFor = (value: number) => (value > 0 ? percent.format(value / total) : "0%");

  // Legend rows map to their segment by DATA index; zero-value rows stay
  // listed (with 0%) but are not hoverable.
  const legendItems = data.map((item, dataIndex) => ({
    item,
    dataIndex:
      Number.isFinite(item.value) && item.value > 0 ? dataIndex : null,
  }));

  const hoveredItem = hover !== null ? data[hover] : undefined;
  const effectiveFocus = arcs.length > 0 ? Math.min(focusIndex, arcs.length - 1) : 0;

  // Elite touch: while a segment is hovered/focused the CENTER becomes a
  // live readout for that slice (value + share), reverting to the total on
  // leave — the fitted font sizing below absorbs any length difference.
  const activeSegment = hoveredItem && hoveredItem.value > 0 ? hoveredItem : null;
  const centerValue = activeSegment
    ? valueTextFor(activeSegment.value)
    : center?.value ?? formatCurrency(total);
  const centerLabel = activeSegment
    ? pctTextFor(activeSegment.value)
    : center?.label ?? "Total";

  // Center text shrinks to fit the donut hole instead of overflowing it.
  const hole = innerRadius * 2;
  const fitFont = (text: string, maxW: number, base: number, min: number, weight: number) => {
    const per100 = measure(text, weight, 100);
    if (per100 <= 0) return base;
    return Math.max(min, Math.min(base, (maxW / per100) * 100));
  };
  const centerValueFont = fitFont(centerValue, hole - 6, 18, 9, 700);
  const centerLabelFont = fitFont(centerLabel, hole + 8, 12, 8, 400);

  function handleSegmentMove(e: React.MouseEvent) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = Math.min(90, rect.width / 2);
    setTip({
      x: Math.min(Math.max(e.clientX - rect.left, margin), Math.max(margin, rect.width - margin)),
      y: Math.max(e.clientY - rect.top, 8),
      above: e.clientY - rect.top >= 96,
    });
  }

  /** Tooltip position for a segment when it is reached by keyboard — the
   *  midpoint of its arc, converted from SVG user units to wrapper pixels. */
  function tipPositionAtSegment(dataIndex: number) {
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    const arc = arcs.find((a) => a.dataIndex === dataIndex);
    if (!wrap || !svg || !arc) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const rad = toRad(arc.mid);
    const r = (radius + innerRadius) / 2;
    const margin = Math.min(90, wrapRect.width / 2);
    const rawX = svgRect.left - wrapRect.left + cx + r * Math.cos(rad);
    const rawY = svgRect.top - wrapRect.top + cy + r * Math.sin(rad);
    return {
      x: Math.min(Math.max(rawX, margin), Math.max(margin, wrapRect.width - margin)),
      y: Math.max(rawY, 8),
      above: rawY >= 96,
    };
  }

  function moveSegmentFocus(fromArcIndex: number, target: number | "first" | "last") {
    const count = arcs.length;
    if (count === 0) return;
    const nextIndex =
      target === "first"
        ? 0
        : target === "last"
          ? count - 1
          : (fromArcIndex + target + count) % count;
    setFocusIndex(nextIndex);
    arcRefs.current[nextIndex]?.focus();
    const arc = arcs[nextIndex]!;
    setHover(arc.dataIndex);
    setTip(tipPositionAtSegment(arc.dataIndex));
  }

  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6",
        className
      )}
    >
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="neu-chart-donut-enter shrink-0"
        role="group"
        aria-label={data
          .map((d) => `${d.label}: ${valueTextFor(d.value)} (${pctTextFor(d.value)})`)
          .join(", ")}
      >
        {arcs.map((arc, arcIndex) => {
          const isHovered = hover === arc.dataIndex;
          const rad = toRad(arc.mid);
          const dx = Math.cos(rad) * DONUT_POP;
          const dy = Math.sin(rad) * DONUT_POP;
          const label = `${arc.item.label}: ${valueTextFor(arc.item.value)} (${pctTextFor(arc.item.value)})`;
          return (
            <path
              key={arc.dataIndex}
              ref={(el) => {
                arcRefs.current[arcIndex] = el;
              }}
              d={arc.path}
              fill={arc.item.color}
              opacity={hover === null || isHovered ? 1 : 0.5}
              tabIndex={arcIndex === effectiveFocus ? 0 : -1}
              role="img"
              aria-label={label}
              className="neu-focus"
              style={{
                transform: isHovered ? `translate(${dx}px, ${dy}px)` : undefined,
                transition: "transform 150ms ease, opacity 150ms ease",
              }}
              onMouseEnter={() => setHover(arc.dataIndex)}
              onMouseLeave={() => {
                setHover((h) => (h === arc.dataIndex ? null : h));
                setTip(null);
              }}
              onMouseMove={handleSegmentMove}
              onFocus={() => {
                setHover(arc.dataIndex);
                setTip(tipPositionAtSegment(arc.dataIndex));
              }}
              onBlur={() => {
                setHover((h) => (h === arc.dataIndex ? null : h));
                setTip(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  moveSegmentFocus(arcIndex, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  moveSegmentFocus(arcIndex, -1);
                } else if (e.key === "Home") {
                  e.preventDefault();
                  moveSegmentFocus(arcIndex, "first");
                } else if (e.key === "End") {
                  e.preventDefault();
                  moveSegmentFocus(arcIndex, "last");
                }
              }}
            >
              <title>{label}</title>
            </path>
          );
        })}
        {/* Center content */}
        <text
          x={cx}
          y={cy - 3}
          textAnchor="middle"
          fontSize={centerValueFont}
          fontWeight={700}
          className="neu-chart-value"
        >
          {centerValue}
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize={centerLabelFont} className="neu-chart-axis">
          {centerLabel}
        </text>
      </svg>

      {/* Legend — full width on mobile, side-by-side on sm+.
          Labels wrap; values and percentages stay right-aligned. */}
      <div
        className={cn(
          "w-full min-w-0 space-y-1 sm:w-auto sm:flex-1",
          !legend && "hidden"
        )}
      >
        {legendItems.map(({ item, dataIndex }, index) => {
          const isHovered = dataIndex !== null && hover === dataIndex;
          return (
            <div
              key={`${item.label}-${index}`}
              className={cn(
                "flex items-start gap-2 rounded-[var(--neu-radius-sm)] px-1.5 py-0.5 text-xs transition-colors",
                isHovered && "bg-neu-sunken/60"
              )}
              onMouseEnter={dataIndex !== null ? () => setHover(dataIndex) : undefined}
              onMouseLeave={
                dataIndex !== null
                  ? () => setHover((h) => (h === dataIndex ? null : h))
                  : undefined
              }
            >
              <span
                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <span className="min-w-0 flex-1 break-words leading-4 text-neu-muted">{item.label}</span>
              <span className="shrink-0 text-end tabular-nums leading-4 text-neu-primary">
                <span className="font-semibold">{valueTextFor(item.value)}</span>
                <span className="ms-1.5 text-neu-faint">{pctTextFor(item.value)}</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Tooltip */}
      {hoveredItem && tip && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: tip.x,
            top: tip.y,
            transform: tip.above ? "translate(-50%, calc(-100% - 10px))" : "translate(-50%, 12px)",
          }}
          aria-hidden
        >
          <div
            className="neu-elevated rounded-[var(--neu-radius-md)] bg-neu-bg px-2.5 py-1.5"
            style={{ maxWidth: TOOLTIP_MAX_W }}
          >
            <p className="flex items-start gap-1.5 break-words text-xs font-semibold leading-4 text-neu-primary">
              <span
                className="mt-1 h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: hoveredItem.color }}
              />
              {hoveredItem.label}
            </p>
            <p className="mt-0.5 text-xs tabular-nums leading-4 text-neu-muted">
              {valueTextFor(hoveredItem.value)}{" "}
              <span className="text-neu-faint">({pctTextFor(hoveredItem.value)})</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Line Chart (Sparkline) ───
interface LineChartProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  /** Larger stroke + area + first/last labels + peak dot for hero cards. */
  axis?: boolean;
  /** Fill the parent's height instead of a fixed pixel height. */
  fillHeight?: boolean;
}

export function LineChart({
  data,
  width = 200,
  height = 40,
  color = "var(--neu-accent-line)",
  className,
  axis = false,
  fillHeight = false,
}: LineChartProps) {
  const gradientId = React.useId().replace(/:/g, "");
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [box, setBox] = React.useState({ w: width, h: height });

  useIsomorphicLayoutEffect(() => {
    if (!fillHeight) return;
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth || width, h: el.clientHeight || height });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fillHeight, width, height]);

  if (data.length === 0) return null;

  const w = fillHeight ? Math.max(80, box.w) : width;
  const h = fillHeight ? Math.max(40, box.h) : height;
  const padX = axis ? 2 : 0;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const peakIndex = data.reduce((best, v, i) => (v > data[best]! ? i : best), 0);

  const points = data.map((val, i) => {
    const x = padX + (i / Math.max(data.length - 1, 1)) * (w - padX * 2);
    const y = h - ((val - min) / range) * (h - 4) - 2;
    return { x, y };
  });
  const pointStr = points.map((p) => `${p.x},${p.y}`).join(" ");
  const fillPoints = [`0,${h}`, ...points.map((p) => `${p.x},${p.y}`), `${w},${h}`].join(" ");
  const last = points[points.length - 1]!;
  const peak = points[peakIndex]!;

  return (
    <div ref={wrapRef} className={cn(!fillHeight && "contents", className)}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className={fillHeight ? "block" : undefined}
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <polygon points={fillPoints} fill={`url(#${gradientId})`} />
        <polyline
          points={pointStr}
          fill="none"
          stroke={color}
          strokeWidth={axis ? 2.25 : 1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {axis && peak.y <= last.y && <circle cx={peak.x} cy={peak.y} r={2.75} fill={color} />}
        <circle cx={last.x} cy={last.y} r={axis ? 2.75 : 2.25} fill={color} />
        {axis && (
          <>
            <text x={0} y={h - 2} className="neu-chart-axis" aria-hidden>
              {compactNumber.format(min)}
            </text>
            <text x={w} y={10} textAnchor="end" className="neu-chart-axis" aria-hidden>
              {compactNumber.format(max)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

// ─── Empty Chart Placeholder ───
function EmptyChart({
  height = 200,
  fill = false,
  className,
}: {
  height?: number;
  fill?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn("neu-inset flex items-center justify-center", className)}
      style={fill ? undefined : { height }}
    >
      <p className="text-sm text-neu-muted">{t("common.noData")}</p>
    </div>
  );
}
