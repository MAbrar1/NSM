import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { runLowStockNotifier } from "@/lib/low-stock";
import { requirePermission } from "@/lib/api/api-auth";

/* ═══════════════════════════════════════════════════════════════
   LOW-STOCK RUN ENDPOINT
   POST /api/notifications/low-stock/run — Execute one scan + delivery
   pass. Authorized by:
     • a signed-in user with inventory:adjust (admin page / dev), or
     • the CRON_SECRET bearer token (platform cron such as Vercel or
       cron-job.org driving this route on a schedule).
   Delivery is throttled per item, so calling it frequently is safe.
   ═══════════════════════════════════════════════════════════════ */

export async function POST(request: NextRequest) {
  try {
    // 1) Session-based permission (manual admin run)
    const { response } = await requirePermission("inventory:adjust");
    if (!response) {
      const result = await runLowStockNotifier();
      return NextResponse.json(result);
    }

    // 2) Shared-secret cron auth
    const secret = process.env["CRON_SECRET"];
    if (secret) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const headerSecret = request.headers.get("x-cron-secret");
      if (token === secret || headerSecret === secret) {
        const result = await runLowStockNotifier();
        return NextResponse.json(result);
      }
    }

    return apiError("Unauthorized", 401);
  } catch (error) {
    console.error("[LOW_STOCK_RUN]", error);
    return NextResponse.json(
      { error: "Internal server error", scanned: 0, sent: 0, throttled: 0, errors: [] },
      { status: 500 }
    );
  }
}
