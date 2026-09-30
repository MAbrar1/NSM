import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { parsePagination } from "@/lib/api/pagination";

/* ═══════════════════════════════════════════════════════════════
   ACTIVITY FEED API
   GET /api/activity — The latest audit events (checkout, refund,
   stock adjustments, customer payments) for the dashboard "Live
   activity" widget. Same source as the audit log, smaller payload.
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler("ACTIVITY_GET", async (request) => {
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
  });
