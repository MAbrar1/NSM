/* ═══════════════════════════════════════════════════════════════
   LOW-STOCK NOTIFIER SCHEDULER
   Three complementary triggers all funnel into the same throttled
   engine (runLowStockNotifier → StockAlertLog cooldown):

   1. Periodic  — instrumentation.ts registers a server-side interval
      (default 30 min) when the app runs under `next start`. This is
      the catch-all for stock that went low between events.
   2. Event     — after any stock-dropping operation (POS checkout,
      inventory adjust, PO receive…) `triggerLowStockScan()` runs a
      scan right away, so a register that sells the last unit fires an
      alert in seconds rather than waiting for the interval.
   3. External  — POST /api/notifications/low-stock/run (guarded by a
      shared secret) so a platform cron (Vercel, cron-job.org…) can
      drive it without an interval in the app process.

   All three are safe to call concurrently: delivery is deduplicated
   per (product, warehouse) by a persisted cooldown timestamp.
   ═══════════════════════════════════════════════════════════════ */

import { runLowStockNotifier } from "@/lib/low-stock";
import { runTrackedJob } from "@/lib/job-status";

/** Job-registry name for the low-stock scan. */
export const LOW_STOCK_JOB = "low-stock-scan" as const;

/** How often the in-process interval scans. */
export const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

/**
 * Start the periodic scan. Idempotent — calling twice (e.g. after a dev
 * server hot-reload re-registers instrumentation) never stacks timers.
 * Runs the first scan shortly after boot rather than waiting a full
 * interval.
 */
export function startLowStockScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runSafely("interval");
  }, SCAN_INTERVAL_MS);

  // First pass soon after startup (interval timers drift; a fresh boot
  // often means a fresh deployment with stale stock).
  setTimeout(() => {
    void runSafely("startup");
  }, 15_000);
}

export function stopLowStockScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Opportunistic trigger — call after a stock-dropping operation. Never
 * throws and never blocks the caller: the scan is cheap (one read of
 * low rows) and delivery is cooldown-throttled, so concurrent callers
 * cannot spam.
 */
export function triggerLowStockScan(source: string): void {
  void runSafely(source);
}

async function runSafely(source: string): Promise<void> {
  if (running) return; // never overlap scans within this process
  running = true;
  try {
    const result = await runTrackedJob(LOW_STOCK_JOB, "scheduler", () =>
      runLowStockNotifier()
    );
    if (!result) return; // recorded as a failed run in the job registry
    if (result.sent > 0) {
      console.log(
        `[LOW_STOCK] scan: ${result.scanned} low, ${result.sent} notified, ${result.throttled} throttled`
      );
    } else if (result.errors.length > 0) {
      console.warn(`[LOW_STOCK] scan errors:`, result.errors.join("; "));
    }
  } catch (err) {
    // Scheduler failures must never take down request handling.
    console.error(`[LOW_STOCK] scan (${source}) failed:`, err);
  } finally {
    running = false;
  }
}
