/* ═══════════════════════════════════════════════════════════════
   RESERVATION CLEANUP SCHEDULER
   Runs the stale-reservation sweep (lib/reservation-cleanup.ts) on
   an interval when the app runs under `next start`, so abandoned
   carts can't lock stock forever on deployments without an external
   cron. Skips `next dev` / `next build` like the other schedulers.

   Idempotent — hot reloads never stack timers. The sweep itself is
   concurrency-safe (conditional releases), and this process-level
   guard prevents overlapping sweeps.
   ═══════════════════════════════════════════════════════════════ */

import { releaseStaleReservations } from "@/lib/inventory/reservation-cleanup";
import { runTrackedJob } from "@/lib/job-status";

/** Job-registry name for the stale-reservation cleanup. */
export const RESERVATION_CLEANUP_JOB = "reservation-cleanup" as const;

/** How often the sweep runs. Stale window is 15 min; scanning every 5 min means a stale hold is freed within ~20 min worst-case. */
export const RESERVATION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

/** Start the periodic sweep. Idempotent — never stacks timers. */
export function startReservationCleanupScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runSafely();
  }, RESERVATION_CLEANUP_INTERVAL_MS);

  // First pass shortly after boot so a restart doesn't inherit stale
  // holds for a full interval.
  setTimeout(() => {
    void runSafely();
  }, 30_000);
}

export function stopReservationCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function runSafely(): Promise<void> {
  if (running) return; // never overlap sweeps within this process
  running = true;
  try {
    const result = await runTrackedJob(RESERVATION_CLEANUP_JOB, "scheduler", () =>
      releaseStaleReservations()
    );
    if (!result) return; // recorded as a failed run in the job registry
    if (result.releasedCount > 0) {
      console.log(
        `[RESERVE_CLEANUP] released ${result.releasedCount} stale reservations (${result.releasedQuantity} units)`
      );
    }
  } catch (err) {
    // Scheduler failures must never take down request handling.
    console.error("[RESERVE_CLEANUP] sweep failed:", err);
  } finally {
    running = false;
  }
}
