import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import { jobStatusSnapshot } from "@/lib/job-status";

/* ═══════════════════════════════════════════════════════════════
   SYSTEM JOBS API
   GET /api/system/jobs — Report the in-process background jobs'
   last runs (outcome, duration, source). Requires settings:view —
   the same gate as the Settings screen that renders it.
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    const { response } = await requirePermission("settings:view");
    if (response) return response;

    return NextResponse.json({
      jobs: jobStatusSnapshot(),
      serverTime: new Date().toISOString(),
      note:
        "In-process status for this server instance. Resets on restart; instances behind a load balancer report independently.",
    });
  } catch (error) {
    console.error("[SYSTEM_JOBS_GET]", error);
    return apiError("Internal server error", 500);
  }
}
