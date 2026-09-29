/* ═══════════════════════════════════════════════════════════════
   MAINTENANCE SCHEDULER
   Runs the periodic housekeeping sweep (stale login attempts +
   orphaned image files — see lib/maintenance.ts) when the app runs
   under `next start`. Skips `next dev` / `next build` like the
   low-stock scheduler.
   ═══════════════════════════════════════════════════════════════ */

import { runMaintenanceSweep } from "@/lib/maintenance";
import { runTrackedJob } from "@/lib/job-status";

/** Job-registry name for the maintenance sweep. */
export const MAINTENANCE_JOB = "maintenance-sweep" as const;

/** How often the sweep runs (daily is plenty for these jobs). */
export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

/** Start the periodic sweep. Idempotent — never stacks timers. */
export function startMaintenanceScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runSafely();
  }, MAINTENANCE_INTERVAL_MS);

  // First pass shortly after boot so deploys start clean.
  setTimeout(() => {
    void runSafely();
  }, 60_000);
}

export function stopMaintenanceScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function runSafely(): Promise<void> {
  if (running) return; // never overlap sweeps
  running = true;
  try {
    const result = await runTrackedJob(MAINTENANCE_JOB, "scheduler", () =>
      runMaintenanceSweep()
    );
    if (!result) return; // recorded as a failed run in the job registry
    if (
      result.deletedOrphans.length > 0 ||
      result.prunedLoginAttempts > 0
    ) {
      console.log(
        `[MAINTENANCE] sweep: pruned ${result.prunedLoginAttempts} login attempts, deleted ${result.deletedOrphans.length} orphan files`
      );
    }
  } catch (err) {
    console.error("[MAINTENANCE] sweep failed:", err);
  } finally {
    running = false;
  }
}