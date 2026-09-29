"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";
import { downloadCsv } from "@/lib/csv";

/* ═══════════════════════════════════════════════════════════════
   IMPORT RESULT DIALOG — elite post-import feedback.
   Shows created/failed/rate stat cards, a per-row error list with
   row numbers and identifiers, and a one-click error-report CSV
   download so users can fix rows and re-import confidently.
   ═══════════════════════════════════════════════════════════════ */

export interface ImportRowError {
  row: number;
  identifier: string;
  error: string;
}

export interface ImportSummary {
  created: number;
  failed: number;
  errors: ImportRowError[];
}

export interface ImportResultDialogProps {
  open: boolean;
  onClose: () => void;
  result: ImportSummary | null;
  title?: string;
  entityLabel: string;
}

export function ImportResultDialog({ open, onClose, result, title, entityLabel }: ImportResultDialogProps) {
  const { t } = useI18n();
  const [showAllErrors, setShowAllErrors] = useState(false);

  const total = result ? result.created + result.failed : 0;
  const rate = total > 0 && result ? Math.round((result.created / total) * 100) : 0;

  const visibleErrors = useMemo(
    () => (result?.errors ?? []).slice(0, showAllErrors ? undefined : 6),
    [result, showAllErrors]
  );

  if (!result) return null;

  const downloadErrorReport = () => {
    downloadCsv(
      `${entityLabel}-import-errors`,
      ["Row", "Record", "Error"],
      result.errors.map((e) => [e.row, e.identifier, e.error])
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? t("import.resultTitle")}</DialogTitle>
          <DialogDescription>
            {entityLabel} — {t("import.resultSubtitle")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* Stat cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-neu-green/30 bg-neu-green/10 px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-neu-ink-green">
                {t("import.created")}
              </div>
              <div className="mt-0.5 text-2xl font-bold text-neu-ink-green">{result.created}</div>
            </div>
            <div className="rounded-xl border border-neu-red/30 bg-neu-red/10 px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-neu-ink-red">
                {t("import.failed")}
              </div>
              <div className="mt-0.5 text-2xl font-bold text-neu-ink-red">{result.failed}</div>
            </div>
            <div className="rounded-xl border border-neu-hairline bg-neu-sunken px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">
                {t("import.successRate")}
              </div>
              <div className="mt-0.5 text-2xl font-bold text-neu-primary">{rate}%</div>
            </div>
          </div>

          {/* Errors block */}
          {result.errors.length > 0 && (
            <div className="rounded-xl border border-neu-amber/30 bg-neu-amber/10">
              <div className="flex items-center justify-between gap-2 border-b border-neu-amber/30 px-3.5 py-2">
                <span className="text-xs font-semibold text-neu-ink-amber">
                  {t("import.issuesFound")} ({result.errors.length})
                </span>
                <button
                  type="button"
                  onClick={downloadErrorReport}
                  className="text-[11px] font-medium text-neu-ink-amber underline-offset-2 hover:underline"
                >
                  {t("import.downloadErrorReport")}
                </button>
              </div>
              <ul className="max-h-44 divide-y divide-neu-amber/20 overflow-y-auto px-3.5">
                {visibleErrors.map((e, i) => (
                  <li key={i} className="flex items-start gap-2 py-1.5 text-xs">
                    <span className="mt-0.5 inline-flex h-4 min-w-[2rem] items-center justify-center rounded bg-neu-amber/20 px-1 text-[10px] font-semibold text-neu-ink-amber">
                      #{e.row}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-neu-primary">{e.identifier}</div>
                      <div className="text-neu-ink-amber">{e.error}</div>
                    </div>
                  </li>
                ))}
              </ul>
              {result.errors.length > 6 && (
                <div className="px-3.5 pb-2.5">
                  <button
                    type="button"
                    onClick={() => setShowAllErrors((s) => !s)}
                    className="text-[11px] font-medium text-neu-ink-amber underline-offset-2 hover:underline"
                  >
                    {showAllErrors ? t("import.showLess") : t("import.showAllN", { n: result.errors.length })}
                  </button>
                </div>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
