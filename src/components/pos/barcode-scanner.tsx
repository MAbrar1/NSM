"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/providers/i18n-provider";
import { useCameraScanner } from "@/hooks/use-camera-scanner";
import { parseScan } from "@/lib/barcode";

/* ═══════════════════════════════════════════════════════════════
   BARCODE SCANNER (premium)
   Camera-based barcode/QR scanning for the POS, product forms and
   variant editors. Backed by use-camera-scanner (native
   BarcodeDetector with a ZXing fallback) so it works on every
   modern browser and device.

   Premium touches: live viewfinder with scan-guides, torch toggle,
   optical zoom slider (on lenses that support it), camera picker,
   continuous multi-scan mode with duplicate suppression and
   scan-history chips, beep + haptic feedback on each accepted scan,
   engine/capability badges, and a manual-entry fallback that works
   even without any camera.
   ═══════════════════════════════════════════════════════════════ */

interface BarcodeScannerProps {
  /**
   * Called for every accepted scan with the RAW scanned value.
   * Use parseScan()/barcodeCandidates() to derive lookup candidates.
   */
  onScan: (value: string) => void;
  /** Close/dismiss callback (fires after autoClose delay in single mode). */
  onClose: () => void;
  className?: string;
  /** Close shortly after the first successful scan (default: false — continuous). */
  autoClose?: boolean;
  /** Restrict formats (defaults to all common 1D + 2D retail formats). */
  formats?: string[];
  /** Fire onScan for every scan, not just the first (default: true). */
  continuous?: boolean;
}

type ScanHistoryItem = { value: string; label: string; at: number };

export function BarcodeScanner({
  onScan,
  onClose,
  className,
  autoClose = false,
  formats,
  continuous = true,
}: BarcodeScannerProps) {
  const { t } = useI18n();
  const [history, setHistory] = React.useState<ScanHistoryItem[]>([]);
  const [manualCode, setManualCode] = React.useState("");
  const closeTimerRef = React.useRef<number | null>(null);
  const onScanRef = React.useRef(onScan);
  onScanRef.current = onScan;

  const handleDecoded = React.useCallback(
    (rawValue: string) => {
      const code = parseScan(rawValue)[0] ?? rawValue;
      setHistory((h) =>
        [{ value: code, label: rawValue, at: Date.now() }, ...h].slice(0, 6)
      );
      onScanRef.current(rawValue);
      if (autoClose && !continuous) {
        if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = window.setTimeout(() => onClose(), 450);
      }
    },
    [autoClose, continuous, onClose]
  );

  const scanner = useCameraScanner({
    onScan: handleDecoded,
    formats,
    beep: true,
    vibrate: true,
  });

  // Stop the camera when the parent unmounts the component.
  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const streaming = scanner.state === "streaming";
  const statusKey: Record<string, string> = {
    idle: "scanner.starting",
    requesting: "scanner.starting",
    streaming: "scanner.scanning",
    denied: "scanner.denied",
    unsupported: "scanner.unsupported",
    error: "scanner.error",
  };

  return (
    <div className={cn("flex flex-col items-center", className)}>
      {/* ─── Viewfinder ─────────────────────────────────────────── */}
      <div className="relative w-full overflow-hidden rounded-xl border border-neu-hairline bg-black">
        <video
          ref={scanner.videoRef}
          className="aspect-[4/3] w-full object-cover sm:aspect-video"
          playsInline
          muted
        />

        {/* Scan guides: corner brackets + laser line */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative h-44 w-60 sm:h-52 sm:w-72">
            <div className="absolute start-0 top-0 h-7 w-7 rounded-ss-lg border-s-[3px] border-t-[3px] border-neu-accent-line" />
            <div className="absolute end-0 top-0 h-7 w-7 rounded-se-lg border-e-[3px] border-t-[3px] border-neu-accent-line" />
            <div className="absolute bottom-0 start-0 h-7 w-7 rounded-es-lg border-b-[3px] border-s-[3px] border-neu-accent-line" />
            <div className="absolute bottom-0 end-0 h-7 w-7 rounded-ee-lg border-b-[3px] border-e-[3px] border-neu-accent-line" />
            {streaming && (
              <div className="absolute inset-x-0 top-1/2 h-0.5 animate-scan bg-neu-accent-solid shadow-[0_0_12px_rgb(var(--neu-cyan-rgb)/0.8)]" />
            )}
          </div>
        </div>

        {/* Top-left status pill */}
        <div className="absolute start-3 top-3 flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur-sm",
              streaming
                ? "bg-neu-solid-green/90 text-white"
                : scanner.state === "requesting"
                  ? "bg-neu-solid-amber/90 text-white"
                  : "bg-neu-solid-red/90 text-white"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                streaming ? "animate-pulse bg-neu-bg" : "bg-neu-bg/80"
              )}
            />
            {streaming ? t("scanner.scanning") : t(statusKey[scanner.state] ?? "scanner.starting")}
          </span>
          {scanner.engine && streaming && (
            <span className="rounded-full bg-black/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur-sm">
              {scanner.engine === "native" ? "BarcodeDetector" : "ZXing"}
            </span>
          )}
        </div>

        {/* Top-right controls: torch + camera switch */}
        <div className="absolute end-3 top-3 flex items-center gap-2">
          {scanner.capabilities.torch && (
            <button
              type="button"
              onClick={() => void scanner.toggleTorch()}
              aria-pressed={scanner.torchOn}
              aria-label={t("scanner.torch")}
              title={t("scanner.torch")}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-sm transition-colors",
                scanner.torchOn
                  ? "bg-neu-solid-amber text-white shadow-lg shadow-neu-solid-amber/40"
                  : "bg-black/50 text-white hover:bg-black/70"
              )}
            >
              {/* flashlight */}
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 2h6l-.6 3.2a2 2 0 01-.6 1.1L12.6 7.5a2 2 0 00-.6 1.4V21a1 1 0 01-2 0V8.9a2 2 0 00-.6-1.4L8.2 6.3a2 2 0 01-.6-1.1L7 2h2z" />
              </svg>
            </button>
          )}
          {scanner.cameras.length > 1 && (
            <button
              type="button"
              onClick={() => {
                const list = scanner.cameras;
                const idx = list.findIndex((c) => c.deviceId === scanner.activeDeviceId);
                const next = list[(idx + 1) % list.length]!;
                scanner.switchCamera(next.deviceId);
              }}
              aria-label={t("scanner.switchCamera")}
              title={t("scanner.switchCamera")}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
            >
              {/* camera-flip */}
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 7h-3l-2-2H9L7 7H4a1 1 0 00-1 1v10a1 1 0 001 1h16a1 1 0 001-1V8a1 1 0 00-1-1z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 14a4 4 0 006.9 2.8M16 12a4 4 0 00-6.9-2.8" />
              </svg>
            </button>
          )}
        </div>

        {/* Bottom: zoom slider (when the lens supports it) */}
        {scanner.capabilities.zoom && scanner.zoom !== null && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8">
            <svg className="h-4 w-4 shrink-0 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M8 11h6M11 8v6M21 21l-4.35-4.35" />
            </svg>
            <input
              type="range"
              min={scanner.capabilities.zoomMin}
              max={scanner.capabilities.zoomMax}
              step={scanner.capabilities.zoomStep || 0.1}
              value={scanner.zoom}
              onChange={(e) => scanner.setZoom(Number(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-neu-bg/30 accent-neu-accent-solid"
              aria-label={t("scanner.zoom")}
            />
          </div>
        )}
      </div>

      {/* ─── Permission / error panels ──────────────────────────── */}
      {(scanner.state === "denied" || scanner.state === "error" || scanner.state === "unsupported") && (
        <div className="mt-3 w-full rounded-xl border border-neu-ink-red/25 bg-neu-wash-red p-3 text-sm text-neu-ink-red">
          <p className="flex items-start gap-2 font-medium">
            <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            {scanner.errorMessage ?? t("scanner.error")}
          </p>
          {scanner.state === "denied" && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => void scanner.start()}>
              {t("scanner.tryAgain")}
            </Button>
          )}
        </div>
      )}

      {/* ─── Scan history chips (continuous mode) ───────────────── */}
      {history.length > 0 && (
        <div className="mt-3 w-full">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neu-faint">
            {t("scanner.recentScans")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {history.map((h) => (
              <button
                key={`${h.value}-${h.at}`}
                type="button"
                onClick={() => onScanRef.current(h.label)}
                title={h.label}
                className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-neu-ink-green/30 bg-neu-wash-green px-2.5 py-1 font-mono text-xs text-neu-ink-green transition-colors"
              >
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="truncate">{h.value}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Manual entry fallback ──────────────────────────────── */}
      <div className="mt-3 w-full">
        <div className="flex items-center gap-2">
          <Input
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manualCode.trim()) {
                onScanRef.current(manualCode.trim());
                setManualCode("");
              }
            }}
            placeholder={t("scanner.manualPlaceholder")}
            className="flex-1 font-mono"
            autoComplete="off"
          />
          <Button
            size="icon-sm"
            variant="secondary"
            onClick={() => {
              if (manualCode.trim()) {
                onScanRef.current(manualCode.trim());
                setManualCode("");
              }
            }}
            disabled={!manualCode.trim()}
            aria-label={t("scanner.manualSubmit")}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-neu-faint">
          {t("scanner.hint")}
        </p>
      </div>

      {/* ─── Actions ────────────────────────────────────────────── */}
      <div className="mt-4 flex w-full items-center justify-between gap-2">
        <span className="text-[11px] text-neu-faint">
          {scanner.cameras.length > 0
            ? `${scanner.cameras.length} ${t("scanner.camerasFound")}`
            : ""}
        </span>
        <div className="flex gap-2">
          {streaming && (
            <Button variant="secondary" onClick={scanner.stop}>
              {t("scanner.pause")}
            </Button>
          )}
          {!streaming && scanner.state !== "denied" && (
            <Button variant="secondary" onClick={() => void scanner.start()}>
              {t("scanner.start")}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
