import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { releaseStaleReservations } from "@/lib/inventory/reservation-cleanup";

/* ═══════════════════════════════════════════════════════════════
   STOCK RESERVATION CLEANUP
   POST /api/inventory/reserve/cleanup — Release reservations that
   went stale: rows whose last reservation is older than
   STALE_AFTER_MS (15 minutes) and were never converted into a sale
   (checkout releases the reserved portion it sells).

   Authorized by:
     • a signed-in user with inventory:adjust (admin page / dev), or
     • the CRON_SECRET bearer token (platform cron such as Vercel or
       cron-job.org) — the middleware exempts this route when the
       secret header matches.
   The in-process scheduler (lib/reservation-scheduler.ts) also runs
   this sweep every 5 minutes under `next start`, so external cron is
   optional belt-and-braces. Delivery is idempotent: releasing an
   already-released row is a no-op.
   ═══════════════════════════════════════════════════════════════ */

export const POST = withApiHandler("RESERVE_CLEANUP", async (request) => {
    // 1) Session-based permission (manual admin run)
    const { response } = await requirePermission("inventory:adjust");
    if (!response) {
      const result = await releaseStaleReservations();
      return NextResponse.json({
        message: `Released ${result.releasedCount} stale reservations`,
        releasedCount: result.releasedCount,
        releasedQuantity: result.releasedQuantity,
      });
    }

    // 2) Shared-secret cron auth (same pattern as the low-stock runner)
    const secret = process.env["CRON_SECRET"];
    if (secret) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const headerSecret = request.headers.get("x-cron-secret");
      if (token === secret || headerSecret === secret) {
        const result = await releaseStaleReservations();
        return NextResponse.json({
          message: `Released ${result.releasedCount} stale reservations`,
          releasedCount: result.releasedCount,
          releasedQuantity: result.releasedQuantity,
        });
      }
    }

    return apiError("Unauthorized", 401);
  });
