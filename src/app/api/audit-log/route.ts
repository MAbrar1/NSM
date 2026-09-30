import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { parsePagination } from "@/lib/api/pagination";
import { parseSortParam } from "@/lib/table-sort";

/* ═══════════════════════════════════════════════════════════════
   AUDIT LOG API
   GET /api/audit-log — List audit log entries with filters.
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler("AUDIT_LOG_GET", async (request) => {
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

    // Allow-listed sort — a hand-edited query falls back to createdAt.desc
    // instead of reaching Prisma's orderBy and throwing. `user` sorts on
    // the related user's name.
    const auditSort = parseSortParam(
      searchParams.get("sort"),
      ["createdAt", "user", "action", "entity"],
      { field: "createdAt", order: "desc" }
    );
    const orderBy: Prisma.AuditLogOrderByWithRelationInput =
      auditSort.field === "user"
        ? { user: { name: auditSort.order } }
        : { [auditSort.field]: auditSort.order };

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, role: true } },
        },
        orderBy,
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
  });
