/* ═══════════════════════════════════════════════════════════════
   PRINT SERVICE — the ONE entry point for printing.
   No screen, component or route calls a printer or window.print
   directly; everything funnels through here:

   - one serialized queue PER PRINTER PROFILE: two receipts for the
     same head never interleave bytes; different printers print in
     parallel
   - per-job timeout (AbortController) → PrintError("TIMEOUT")
   - failures are typed (OFFLINE/TIMEOUT/TRANSPORT/…) and NEVER
     re-run a sale: the caller retries from the saved record
   - the print-log write (ReceiptPrintLog) happens for every attempt;
     a retry of a failed first print stays action=PRINT (the rule
     lives in lib/receipt-print.ts, driven by this service's result)

   Browser-only module ("use client" semantics via DOM guards).
   ═══════════════════════════════════════════════════════════════ */

import { PrintDriver, PrintError, PrintJob, DriverProfile } from "./driver";
import { EscPosRasterDriver, EscPosTextDriver, BrowserPrintDriver, PdfDriver } from "./drivers";
import {
  recordPrintSuccess,
  recordPrintFailure,
  isDuplicateRequest,
  markJobFailed,
  clearJobFailure,
  recordEvent,
} from "./print-intelligence";

/** Default per-job timeout. Generous: thermal rendering of a 500-line
 *  receipt can take seconds before the first byte moves. */
const DEFAULT_TIMEOUT_MS = 20_000;

interface QueueEntry {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** A serialized job queue for one printer profile. */
class PrinterQueue {
  private chain: Promise<unknown> = Promise.resolve();

  push<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    // Keep the chain alive regardless of job outcome.
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

const queues = new Map<string, PrinterQueue>();

function queueFor(profileId: string): PrinterQueue {
  let q = queues.get(profileId);
  if (!q) {
    q = new PrinterQueue();
    queues.set(profileId, q);
  }
  return q;
}

/** The one driver registry. Adding a driver = adding it here. */
const drivers: Partial<Record<PrintJob["kind"], PrintDriver>> = {};

if (typeof window !== "undefined") {
  drivers["escpos-raster"] = new EscPosRasterDriver();
  drivers["escpos-text"] = new EscPosTextDriver();
  drivers["browser-html"] = new BrowserPrintDriver();
  drivers["pdf"] = new PdfDriver();
}

export function registerDriver(driver: PrintDriver): void {
  drivers[driver.kind] = driver;
}

function driverFor(kind: PrintJob["kind"]): PrintDriver {
  const driver = drivers[kind];
  if (!driver) {
    throw new PrintError("UNSUPPORTED", `No driver registered for job kind "${kind}"`);
  }
  return driver;
}

export interface PrintOptions {
  /** Per-job timeout in ms (default 20s). */
  timeoutMs?: number;
  /** Abort a queued/running job. */
  signal?: AbortSignal;
}

/**
 * Enqueue a print job on the target printer's serialized queue.
 * Resolves when the host accepted the job; rejects with PrintError
 * on any failure (never raw transport errors).
 */
export function enqueuePrint(
  job: PrintJob,
  profile: DriverProfile,
  opts: PrintOptions = {}
): Promise<void> {
  const driver = driverFor(job.kind);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const jobKey = `${profile.id}:${job.id}`;

  // Duplicate collapse: the same receipt requested twice within the
  // window (double-click, Enter spam) resolves silently as success —
  // the paper never comes out twice for one intent. A job whose last
  // attempt FAILED is never suppressed: retries go straight through.
  if (isDuplicateRequest(jobKey)) return Promise.resolve();

  return queueFor(profile.id).push(async () => {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(new PrintError("CANCELLED", "Job aborted"));
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const startedAt = Date.now();
    try {
      await Promise.race([
        driver.print(job, profile, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              const reason = controller.signal.reason as unknown;
              if (reason instanceof PrintError) reject(reason);
              else if (opts.signal?.aborted) reject(new PrintError("CANCELLED", "Job aborted"));
              else reject(new PrintError("TIMEOUT", `Print job exceeded ${timeoutMs}ms`));
            },
            { once: true }
          );
        }),
      ]);
      recordPrintSuccess(profile.id);
      clearJobFailure(jobKey);
      recordEvent({ profileId: profile.id, kind: job.kind as string, ok: true, at: startedAt });
    } catch (err) {
      const code = err instanceof PrintError ? err.code : "TRANSPORT";
      recordPrintFailure(profile.id, code, (err as Error).message);
      markJobFailed(jobKey);
      recordEvent({ profileId: profile.id, kind: job.kind as string, ok: false, at: startedAt, errorCode: code });
      if (err instanceof PrintError) throw err;
      // Drivers wrap their own errors; this is a safety net.
      throw new PrintError("TRANSPORT", `Print failed: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  });
}

/** Non-throwing availability probe for the settings UI. */
export async function printerAvailable(profile: DriverProfile): Promise<boolean> {
  try {
    const driver = driverFor(profileKindForConnection(profile.connectionType));
    return await driver.isAvailable(profile);
  } catch {
    return false;
  }
}

function profileKindForConnection(connectionType: string): PrintJob["kind"] {
  switch (connectionType) {
    case "browser":
      return "browser-html";
    case "text":
      return "escpos-text";
    case "loopback":
    case "webusb":
    case "webserial":
    default:
      return "escpos-raster";
  }
}

/** Test hook: reset queues between tests (not for app code). */
export function resetPrintQueues(): void {
  queues.clear();
}
