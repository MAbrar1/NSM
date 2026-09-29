import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { parsePagination } from "@/lib/pagination";

/* ═══════════════════════════════════════════════════════════════
   AUDIT LOG API
   GET /api/audit-log — List audit log entries with filters.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("settings:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const entity = searchParams.get("entity") ?? undefined;
    const action = searchParams.get("action") ?? undefined;
    const userId = searchParams.get("userId") ?? undefined;
    const { page, pageSize, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 30,
    });

    const where: Record<string, unknown> = {};
    if (entity) where["entity"] = entity;
    if (action) where["action"] = action;
    if (userId) where["userId"] = userId;

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, role: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      db.auditLog.count({ where }),
    ]);

    return NextResponse.json({
      logs,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("[AUDIT_LOG_GET]", error);
    return apiError("Internal server error", 500);
  }
}
