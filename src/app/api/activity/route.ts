import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { parsePagination } from "@/lib/pagination";

/* ═══════════════════════════════════════════════════════════════
   ACTIVITY FEED API
   GET /api/activity — The latest audit events (checkout, refund,
   stock adjustments, customer payments) for the dashboard "Live
   activity" widget. Same source as the audit log, smaller payload.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("dashboard:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const { pageSize: take } = parsePagination(searchParams, {
      defaultPageSize: 12,
      maxPageSize: 50,
      pageSizeParam: "limit",
    });

    const events = await db.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        action: true,
        entity: true,
        entityName: true,
        entityId: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });

    return NextResponse.json({ events });
  } catch (error) {
    console.error("[ACTIVITY_GET]", error);
    return apiError("Internal server error", 500);
  }
}
