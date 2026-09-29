import { db } from "@/lib/db";
import { releaseStaleReservation } from "@/lib/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   STOCK RESERVATION CLEANUP (shared engine)
   Releases reservations that went stale: rows whose last reservation
   is older than STALE_AFTER_MS (15 minutes) and were never converted
   into a sale (checkout releases the reserved portion it sells).
   Rows with no reservation timestamp are treated as stale too, so
   reservations created before this feature landed are still released.

   Three complementary triggers all funnel into this one engine:

   1. Periodic  — instrumentation.ts registers a server-side interval
      (production only) via lib/reservation-scheduler.ts, so abandoned
      carts can't lock stock forever on deployments without cron.
   2. External  — POST /api/inventory/reserve/cleanup, guarded by a
      session or the CRON_SECRET bearer token (platform cron).
   3. Manual    — the same endpoint from an admin page / dev.

   Safe to run concurrently: each row is released with a conditional
   update and the sweep never throws to its caller.
   ═══════════════════════════════════════════════════════════════ */

/** How long a reservation may sit before it is considered stale. */
export const STALE_AFTER_MS = 15 * 60 * 1000; // 15 minutes

export interface ReservationCleanupResult {
  /** Rows that had stale reservations released. */
  releasedCount: number;
  /** Total quantity freed across all released rows. */
  releasedQuantity: number;
}

/**
 * Release every stale reservation. Never throws — failures are logged
 * and surfaced in the result count, so a scheduler can fire it blindly.
 */
export async function releaseStaleReservations(
  staleAfterMs: number = STALE_AFTER_MS
): Promise<ReservationCleanupResult> {
  const cutoff = new Date(Date.now() - staleAfterMs);

  // Only rows with reserved stock, and only when the reservation is
  // stale (or predates reservation tracking entirely).
  let staleLevels: Array<{
    id: string;
    reservedQuantity: number;
  }> = [];

  try {
    staleLevels = await db.stockLevel.findMany({
      where: {
        reservedQuantity: { gt: 0 },
        OR: [{ reservedAt: { lt: cutoff } }, { reservedAt: null }],
      },
      select: {
        id: true,
        reservedQuantity: true,
      },
    });
  } catch (err) {
    console.error("[RESERVE_CLEANUP] scan failed:", err);
    return { releasedCount: 0, releasedQuantity: 0 };
  }

  let releasedCount = 0;
  let releasedQuantity = 0;

  for (const level of staleLevels) {
    if (level.reservedQuantity <= 0) continue;
    try {
      // Conditional release through the one stock writer: clears the
      // reservation only while it is still untouched since the scan (a
      // checkout may have consumed it meanwhile) and handles the legacy
      // NULL-reservedAt rows that predate reservation tracking.
      const released = await releaseStaleReservation(db, level.id, { cutoff });
      if (!released) continue; // released elsewhere meanwhile
      releasedCount += 1;
      releasedQuantity += level.reservedQuantity;
    } catch (err) {
      // One bad row must not abort the whole sweep — but it must not be
      // reported as released either; the next pass will retry it.
      console.error("[RESERVE_CLEANUP] release failed:", err);
    }
  }

  return { releasedCount, releasedQuantity };
}
