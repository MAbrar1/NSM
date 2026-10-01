/* ═══════════════════════════════════════════════════════════════
   PRINT DRIVER INTERFACE — the one contract every driver implements.
   Drivers:
     - EscPosRasterDriver  (primary thermal: 1-bit bitmap → ESC/POS)
     - EscPosTextDriver    (optional, English-only text mode)
     - BrowserPrintDriver  (reports, PWA fallback via window.print)
     - PdfDriver           (share/email/archive)
   No screen, component or route ever calls a printer or
   window.print directly — everything goes through the PrintService
   (print-service.ts) which serializes jobs per printer profile.

   Typed errors (PrintError) carry a machine code so callers can
   branch: OFFLINE, TIMEOUT, TRANSPORT, PAPER_OUT (when detectable),
   CANCELLED, UNSUPPORTED.
   ═══════════════════════════════════════════════════════════════ */

/** Machine-readable failure codes — callers branch on these. */
export type PrintErrorCode =
  | "OFFLINE"
  | "TIMEOUT"
  | "TRANSPORT"
  | "PAPER_OUT"
  | "CANCELLED"
  | "UNSUPPORTED";

export class PrintError extends Error {
  constructor(
    public code: PrintErrorCode,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = "PrintError";
    // `cause` is an Error base-class member in ES2022; keep our detail
    // payload under a distinct name to avoid override modifiers.
  }
}

/** A render job the driver can consume. Renderers produce the
 *  payload; drivers only move bytes/window content to hardware. */
export interface PrintJob {
  /** Stable job id (used in logs and retry bookkeeping). */
  id: string;
  /** What to print, per driver kind. */
  kind: "escpos-raster" | "escpos-text" | "browser-html" | "pdf";
  /** ESC/POS byte stream (escpos-raster / escpos-text). */
  bytes?: Uint8Array;
  /** Standalone HTML document (browser-html). */
  html?: string;
  /** PDF bytes (pdf) — passed through to save/share. */
  pdf?: Uint8Array;
  filename?: string;
}

/** Common profile fields drivers need (subset of PrinterProfile). */
export interface DriverProfile {
  id: string;
  name: string;
  connectionType: string;
  connectionTarget: string | null;
  charsPerLine: number;
  feedBeforeCutLines: number;
  cutMode: "full" | "partial" | "none";
  drawerKick: boolean;
  drawerPin: 2 | 5;
}

export interface PrintDriver {
  /** Driver kind marker — the PrintService routes jobs by this. */
  readonly kind: PrintJob["kind"];
  /** Human-readable name for logs/diagnostics. */
  readonly name: string;
  /**
   * Send a job. Implementations MUST:
   *  - never throw raw DOM/network errors (wrap in PrintError)
   *  - resolve only when the host accepted the job (not paper-confirmed)
   *  - respect the caller's abort signal
   */
  print(job: PrintJob, profile: DriverProfile, signal?: AbortSignal): Promise<void>;
  /** Non-throwing availability probe (transport present, paired, …). */
  isAvailable(profile: DriverProfile): Promise<boolean>;
}
