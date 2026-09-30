"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePopoverMenu } from "@/hooks/use-popover-menu";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";
import {
  downloadCsv,
  downloadExcel,
  downloadTemplate,
  stampFilename,
  sumFormulaCell,
  type ExcelSheet,
  type XlsxCell,
  type XlsxStyle,
} from "@/lib/files/csv";
import { fetchReportSettings, previewReport, printReport, type PrintColumn } from "@/lib/print/print-report";

/* ═══════════════════════════════════════════════════════════════
   SHARED EXPORT MENU
   A single elite dropdown used by every page's header: CSV, Excel
   (styled .xlsx via the dependency-free writer) and Print (A4 doc
   via the shared print engine). Also supports a Template download
   for import pages and custom entries for special exports.
   ═══════════════════════════════════════════════════════════════ */

export type ExportAlign = "left" | "right" | "center";

export interface ExportColumn<T> {
  header: string;
  /** Raw value for CSV. */
  value: (row: T) => string | number | boolean | null | undefined;
  /** Excel cell override (defaults to the CSV value). */
  excel?: (row: T) => unknown;
  /** Numeric style applied to the Excel column. */
  excelStyle?: "money" | "int" | "percent" | "bold";
  /** Exclude this column from the Excel export. */
  omitExcel?: boolean;
  /** Exclude this column from the printed document. */
  omitPrint?: boolean;
  /** Printed column config (defaults mirror the CSV column). */
  print?: {
    label?: string;
    align?: ExportAlign;
    width?: string;
    strong?: boolean;
    muted?: boolean;
    /** Totals-row cell for this column. */
    total?: (rows: T[]) => string;
  };
}

export interface PrintKpi {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative" | "warning";
  hint?: string;
}

export interface ExportMenuItem {
  label: string;
  icon: "csv" | "excel" | "print" | "template" | string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
}

export interface ExportMenuProps<T> {
  rows: T[];
  columns: ExportColumn<T>[];
  /** Filename stem: `products`, `orders` … (date is appended). */
  fileStem: string;
  /** Sheet name for Excel; also the default print doc title. */
  sheetName?: string;
  /** Show the "Download template" item (import pages). */
  template?: { headers: string[]; exampleRows: string[][] };
  /** Custom items appended after the standard entries. */
  customItems?: ExportMenuItem[];
  /** KPI cards for the printed document. */
  printKpis?: PrintKpi[];
  /** Human period subtitle for the print title band, e.g. "Jan – Sep 2026". */
  period?: string;
  /** Meta rows under the KPIs in the print doc. */
  printMeta?: Array<{ label: string; value: string }>;
  /** Label for the printed totals row. */
  printTotalsLabel?: string;
  /** Print kicker above the doc title (defaults to sheetName). */
  printKicker?: string;
  /** Custom print handler (page-driven). When omitted, a document is
   *  built automatically from the columns' `print` config. */
  onPrint?: () => void | Promise<void>;
  /** Custom in-app preview handler (page-driven, mirrors `onPrint`).
   *  Shown only when provided; the auto-built document previews
   *  without it. */
  onPreview?: () => void | Promise<void>;
  disabled?: boolean;
}

/* ── icons (inline SVG, no dependency) ─────────────────────────── */

function Icon({ name }: { name: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "csv")
    return (
      <svg {...common}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8M8 17h8" />
      </svg>
    );
  if (name === "excel")
    return (
      <svg {...common}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="m9.5 12.5 5 6M14.5 12.5l-5 6" />
      </svg>
    );
  if (name === "print")
    return (
      <svg {...common}>
        <path d="M6 9V2h12v7" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" rx="1" />
      </svg>
    );
  if (name === "preview")
    return (
      <svg {...common}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  /* template */
  return (
    <svg {...common}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ transition: "transform 150ms", transform: "rotate(0deg)" }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/* ── the menu ──────────────────────────────────────────────────── */

export function ExportMenu<T>(props: ExportMenuProps<T>) {
  const { t, dir } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /* close on outside click */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // Escape / Tab / arrows and the focus handoff. This replaced a local Escape
  // handler that was the menu's only key: Escape did work here, but the menu
  // could not be walked with the arrow keys and Tab left it open.
  usePopoverMenu({ open, triggerRef: buttonRef, panelRef, onClose: () => setOpen(false) });

  const run = useCallback(
    async (fn: () => void | Promise<void>) => {
      try {
        setBusy(true);
        setOpen(false);
        await fn();
      } catch (err) {
        console.error("[ExportMenu]", err);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const csvColumns = props.columns;
  const excelColumns = props.columns.filter((c) => !c.omitExcel);

  const doCsv = () =>
    run(() => {
      downloadCsv(props.fileStem, csvColumns.map((c) => c.header), props.rows.map((r) => csvColumns.map((c) => c.value(r))));
    });

  const doExcel = () =>
    run(() => {
      // Totals row: numeric columns with a print.total get a LIVE SUM
      // formula (recalculates if the user edits/filters the sheet);
      // everything else keeps its formatted total as bold text.
      const isNumeric = /^-?[\d,]+(\.\d+)?$/;
      const totals: XlsxCell[] | undefined = excelColumns.some((c) => c.print?.total)
        ? excelColumns.map((c, idx) => {
            if (!c.print?.total) return null;
            if (c.excelStyle === "money" || c.excelStyle === "int") {
              const numericCol = props.rows.length > 0 &&
                props.rows.every((r) =>
                  isNumeric.test(String((c.excel ? c.excel(r) : c.value(r)) ?? "").trim())
                );
              if (numericCol) {
                return sumFormulaCell(idx, props.rows.length, c.excelStyle === "money" ? "money-bold" : "int-bold");
              }
            }
            return { v: c.print.total(props.rows), style: "bold" as const };
          })
        : undefined;

      const sheet: ExcelSheet = {
        name: props.sheetName ?? props.fileStem,
        headers: excelColumns.map((c) => c.header),
        rows: props.rows.map(
          (r): XlsxCell[] =>
            excelColumns.map(
              (c): XlsxCell =>
                c.excelStyle
                  ? {
                      v: ((c.excel ? c.excel(r) : c.value(r)) ?? null) as NonNullable<
                        string | number | boolean | null | undefined
                      >,
                      style: c.excelStyle as XlsxStyle,
                    }
                  : ((c.excel ? c.excel(r) : c.value(r)) as XlsxCell)
            )
        ),
        totals,
      };
      downloadExcel(props.fileStem, [sheet]);
    });

  const doPrint = useCallback(async () => {
    if (props.onPrint) {
      await props.onPrint();
      return;
    }
    const settings = await fetchReportSettings(t("app.name"));
    const printable = props.columns.filter((c) => !c.omitPrint && c.print);
    const columns: PrintColumn<T>[] = printable.map((c) => ({
      label: c.print!.label ?? c.header,
      align: c.print!.align,
      width: c.print!.width,
      strong: c.print!.strong,
      muted: c.print!.muted,
      value: (row: T) => String(c.value(row) ?? ""),
      total: c.print!.total,
    }));
    const hasTotals = printable.some((c) => c.print!.total);
    printReport(
      {
        title: props.sheetName ?? props.fileStem,
        kicker: props.printKicker ?? t("export.export"),
        periodLabel: props.period,
        kpis: props.printKpis,
        meta: props.printMeta,
        columns,
        rows: props.rows,
        totalsLabel: hasTotals ? (props.printTotalsLabel ?? t("export.total")) : undefined,
      },
      settings,
      { rtl: dir === "rtl", onBlocked: () => console.warn("[ExportMenu] print popup blocked") }
    );
  }, [props, t, dir]);

  /* In-app preview: page-supplied handler, or the auto-built document
     rendered in the PrintPreview modal (no print dialog, no popup). */
  const doPreview = useCallback(async () => {
    if (props.onPreview) {
      await props.onPreview();
      return;
    }
    const settings = await fetchReportSettings(t("app.name"));
    const printable = props.columns.filter((c) => !c.omitPrint && c.print);
    const columns: PrintColumn<T>[] = printable.map((c) => ({
      label: c.print!.label ?? c.header,
      align: c.print!.align,
      width: c.print!.width,
      strong: c.print!.strong,
      muted: c.print!.muted,
      value: (row: T) => String(c.value(row) ?? ""),
      total: c.print!.total,
    }));
    const hasTotals = printable.some((c) => c.print!.total);
    await previewReport(
      {
        title: props.sheetName ?? props.fileStem,
        kicker: props.printKicker ?? t("export.export"),
        periodLabel: props.period,
        kpis: props.printKpis,
        meta: props.printMeta,
        columns,
        rows: props.rows,
        totalsLabel: hasTotals ? (props.printTotalsLabel ?? t("export.total")) : undefined,
      },
      settings,
      { rtl: dir === "rtl", filename: props.fileStem }
    );
  }, [props, t, dir]);

  const items: ExportMenuItem[] = [
    { label: t("export.preview"), icon: "preview", onSelect: doPreview },
    { label: t("export.csv"), icon: "csv", onSelect: doCsv },
    { label: t("export.excel"), icon: "excel", onSelect: doExcel },
    ...(props.template
      ? [
          {
            label: t("export.template"),
            icon: "template",
            onSelect: () =>
              run(() => downloadTemplate(props.fileStem, props.template!.headers, props.template!.exampleRows)),
          },
        ]
      : []),
    ...(props.customItems ?? []),
    { label: t("export.print"), icon: "print", onSelect: doPrint },
  ];

  return (
    <div ref={rootRef} className="relative inline-block">
      <Button
        ref={buttonRef}
        variant="secondary"
        disabled={props.disabled || busy}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="gap-2"
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 10 5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
        {t("export.export")}
        <Chevron />
      </Button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={t("export.export")}
          /* Under `sm` the menu is anchored to the VIEWPORT's bottom edge
             instead of to the button: a page toolbar can sit anywhere along
             the row, and a 190px panel pinned to the END edge of a button
             near the left of a 375px screen hangs off it (measured: -33px).
             The bottom sheet always fits and is reachable by thumb. */
          className="neu-elevated fixed inset-x-2 bottom-4 z-50 max-h-[min(24rem,calc(100dvh-2rem))] min-w-0 overflow-y-auto overscroll-contain rounded-xl border border-neu-hairline py-1.5 animate-scale-in sm:absolute sm:inset-x-auto sm:bottom-auto sm:end-0 sm:top-full sm:mt-2 sm:max-h-[70dvh] sm:min-w-[190px] sm:max-w-[calc(100vw-1rem)]"
        >
          <div className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-neu-faint">
            {t("export.formats")}
          </div>
          {items.map((item, i) => (
            <button
              key={`${item.label}-${i}`}
              role="menuitem"
              disabled={item.disabled || busy}
              onClick={() => void run(item.onSelect)}
              className="neu-focus flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm text-neu-primary transition-colors hover:bg-neu-sunken disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="text-neu-faint">
                <Icon name={item.icon} />
              </span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export { stampFilename };
