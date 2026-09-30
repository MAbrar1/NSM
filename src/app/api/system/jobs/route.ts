import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { jobStatusSnapshot } from "@/lib/job-status";

/* ═══════════════════════════════════════════════════════════════
   SYSTEM JOBS API
   GET /api/system/jobs — Report the in-process background jobs'
   last runs (outcome, duration, source). Requires settings:view —
   the same gate as the Settings screen that renders it.
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler("SYSTEM_JOBS_GET", async () => {
    const { response } = await requirePermission("settings:view");
    if (response) return response;

    return NextResponse.json({
      jobs: jobStatusSnapshot(),
      serverTime: new Date().toISOString(),
      note:
        "In-process status for this server instance. Resets on restart; instances behind a load balancer report independently.",
    });
  });
