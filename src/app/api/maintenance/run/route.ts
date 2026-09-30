import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import { runMaintenanceSweep } from "@/lib/maintenance";
import { runTrackedJob } from "@/lib/job-status";

/* ═══════════════════════════════════════════════════════════════
   MAINTENANCE RUN ENDPOINT
   POST /api/maintenance/run — Execute one housekeeping sweep
   (stale login attempts + orphaned image cleanup). Authorized by:
     • a signed-in user with settings:edit (admin page / dev), or
     • the CRON_SECRET bearer token (platform cron).
   The sweep itself is idempotent, so frequent calls are safe.

   This was the only scheduled job without a manual/cron trigger —
   low-stock and reservation cleanup already had one each.
   ═══════════════════════════════════════════════════════════════ */

export async function POST(request: NextRequest) {
  try {
    // 1) Session-based permission (manual admin run)
    const { response } = await requirePermission("settings:edit");
    if (!response) {
      const result = await runTrackedJob("maintenance-sweep", "manual", () =>
        runMaintenanceSweep()
      );
      if (!result) {
        return apiError("Maintenance sweep failed", 500);
      }
      return NextResponse.json(result);
    }

    // 2) Shared-secret cron auth (same pattern as the other run routes)
    const secret = process.env["CRON_SECRET"];
    if (secret) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const headerSecret = request.headers.get("x-cron-secret");
      if (token === secret || headerSecret === secret) {
        const result = await runTrackedJob("maintenance-sweep", "cron", () =>
          runMaintenanceSweep()
        );
        if (!result) {
          return apiError("Maintenance sweep failed", 500);
        }
        return NextResponse.json(result);
      }
    }

    return apiError("Unauthorized", 401);
  } catch (error) {
    console.error("[MAINTENANCE_RUN]", error);
    return NextResponse.json(
      { error: "Internal server error", prunedLoginAttempts: 0, deletedOrphans: [], scannedFiles: 0 },
      { status: 500 }
    );
  }
}
