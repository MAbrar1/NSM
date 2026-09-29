"use client";

import * as React from "react";
import { cn, formatCurrency } from "@/lib/utils";
import { useI18n } from "@/components/providers/i18n-provider";

/* ═══════════════════════════════════════════════════════════════
   CHART COMPONENTS
   Lightweight SVG-based charts. No external charting library needed.
   ═══════════════════════════════════════════════════════════════ */

// ─── Bar Chart ───
// Rows may carry extra metadata (e.g. a raw month key) for drill-down.
type BarRow = { label: string; value: number; [key: string]: unknown };

/** Compact number for dense chart labels (12345 → "12.3K"). */
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

interface BarChartProps {
  data: BarRow[];
  height?: number;
  color?: string;
  formatValue?: (v: number) => string;
  /** Show compact values (12.3K) atop bars/axis instead of full currency. */
  compactValueLabels?: boolean;
  onBarClick?: (entry: BarRow) => void;
  className?: string;
}

export function BarChart({
  data,
  height = 200,
  color = "var(--neu-accent-line)",
  formatValue = formatCurrency,
  compactValueLabels = false,
  onBarClick,
  className,
}: BarChartProps) {
  if (data.length === 0) return <EmptyChart height={height} className={className} />;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const gutterLeft = 44;
  const barWidth = Math.max(8, Math.floor(600 / data.length) - 4);
  const svgWidth = Math.max(data.length * (barWidth + 4) + gutterLeft + 8, 300);
  const plotBottom = height - 30;
  const plotHeight = height - 40;
  const formatLabel = compactValueLabels
    ? (v: number) => compactNumber.format(v)
    : formatValue;

  return (
    <div className={cn("overflow-x-auto", className)}>
      <svg
        width={svgWidth}
        height={height}
        viewBox={`0 0 ${svgWidth} ${height}`}
        className="w-full"
        role="img"
        aria-label={data.map((d) => `${d.label}: ${formatValue(d.value)}`).join(", ")}
      >
        {/* Grid lines + compact y-axis reference labels.
            The ink comes from .neu-chart-grid / .neu-chart-axis, which
            are the only place these colours are declared. */}
        {[0.25, 0.5, 0.75, 1].map((pct) => {
          const y = plotBottom - plotHeight * pct;
          return (
            <g key={pct} aria-hidden>
              <line
                x1={gutterLeft}
                y1={y}
                x2={svgWidth - 4}
                y2={y}
                className="neu-chart-grid"
                strokeDasharray="4"
              />
              <text
                x={gutterLeft - 6}
                y={y + 3}
                textAnchor="end"
                className="neu-chart-axis"
              >
                {formatLabel(maxVal * pct)}
              </text>
            </g>
          );
        })}
        {/* Baseline */}
        <line
          x1={gutterLeft}
          y1={plotBottom}
          x2={svgWidth - 4}
          y2={plotBottom}
          className="neu-chart-baseline"
          aria-hidden
        />

        {/* Bars */}
        {data.map((d, i) => {
          const barHeight = Math.max(2, (plotHeight * d.value) / maxVal);
          const x = gutterLeft + 4 + i * (barWidth + 4);
          const y = plotBottom - barHeight;

          return (
            <g
              key={i}
              className={onBarClick ? "cursor-pointer" : undefined}
              role={onBarClick ? "button" : undefined}
              tabIndex={onBarClick ? 0 : undefined}
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
              aria-label={onBarClick ? `${d.label}: ${formatValue(d.value)}` : undefined}
            >
              {/* Flat semantic fill — no box-shadow, no gradient, so the
                  data never carries the emboss. */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={4}
                fill={color}
                className="opacity-90 transition-opacity hover:opacity-100"
              >
                <title>{`${d.label}: ${formatValue(d.value)}`}</title>
              </rect>
              {/* Value label on top */}
              {data.length <= 15 && (
                <text
                  x={x + barWidth / 2}
                  y={y - 4}
                  textAnchor="middle"
                  fontWeight="600"
                  className="neu-chart-axis"
                >
                  {d.value > 0 ? formatLabel(d.value) : ""}
                </text>
              )}
              {/* X-axis label */}
              {data.length <= 15 && (
                <text
                  x={x + barWidth / 2}
                  y={height - 14}
                  textAnchor="middle"
                  className="neu-chart-axis"
                >
                  {d.label.length > 6 ? d.label.slice(0, 6) + "…" : d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
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
}

export function DonutChart({ data, size = 160, className, center }: DonutChartProps) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return <EmptyChart height={size} className={className} />;

  const radius = size / 2 - 10;
  const innerRadius = radius * 0.6;
  const cx = size / 2;
  const cy = size / 2;

  let cumulative = 0;

  return (
    <div className={cn("flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6", className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {data.map((d, i) => {
          const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
          cumulative += d.value;
          const endAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
          const largeArc = d.value / total > 0.5 ? 1 : 0;

          const x1 = cx + radius * Math.cos(startAngle);
          const y1 = cy + radius * Math.sin(startAngle);
          const x2 = cx + radius * Math.cos(endAngle);
          const y2 = cy + radius * Math.sin(endAngle);
          const ix1 = cx + innerRadius * Math.cos(startAngle);
          const iy1 = cy + innerRadius * Math.sin(startAngle);
          const ix2 = cx + innerRadius * Math.cos(endAngle);
          const iy2 = cy + innerRadius * Math.sin(endAngle);

          const path = [
            `M ${x1} ${y1}`,
            `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
            `L ${ix2} ${iy2}`,
            `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1}`,
            "Z",
          ].join(" ");

          return (
            <path key={i} d={path} fill={d.color}>
              <title>{`${d.label}: ${d.value}`}</title>
            </path>
          );
        })}
        {/* Center content */}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="18" fontWeight="bold" className="neu-chart-value">
          {center?.value ?? formatCurrency(total)}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="neu-chart-axis">
          {center?.label ?? "Total"}
        </text>
      </svg>

      {/* Legend — full width on mobile, side-by-side on sm+ */}
      <div className="w-full space-y-1.5 sm:w-auto">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
            <span className="text-neu-muted">{d.label}</span>
            <span className="ms-auto font-semibold tabular-nums text-neu-primary sm:ms-3">
              {center ? String(d.value) : formatCurrency(d.value)}
            </span>
          </div>
        ))}
      </div>
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
}

export function LineChart({
  data,
  width = 200,
  height = 40,
  color = "var(--neu-accent-line)",
  className,
}: LineChartProps) {
  if (data.length === 0) return null;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data.map((val, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * width;
    const y = height - ((val - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });

  const fillPoints = [`0,${height}`, ...points, `${width},${height}`].join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
      <polygon points={fillPoints} fill={color} opacity={0.1} />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

// ─── Empty Chart Placeholder ───
function EmptyChart({ height = 200, className }: { height?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <div
      className={cn("neu-inset flex items-center justify-center", className)}
      style={{ height }}
    >
      <p className="text-sm text-neu-muted">{t("common.noData")}</p>
    </div>
  );
}
