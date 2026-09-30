import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { parsePagination } from "@/lib/api/pagination";

/* ═══════════════════════════════════════════════════════════════
   INVENTORY MOVEMENTS API
   GET /api/inventory/movements — List all stock movements with filters.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const warehouseId = searchParams.get("warehouseId") ?? undefined;
    const productId = searchParams.get("productId") ?? undefined;
    const type = searchParams.get("type") ?? undefined;
    const { page, pageSize, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 30,
    });

    const where: Record<string, unknown> = {};
    if (warehouseId) where["warehouseId"] = warehouseId;
    if (productId) where["productId"] = productId;
    if (type) where["type"] = type;

    const [movements, total] = await Promise.all([
      db.inventoryMovement.findMany({
        where,
        include: {
          product: { select: { id: true, name: true, sku: true, unit: true } },
          warehouse: { select: { name: true, code: true } },
          performedBy: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      db.inventoryMovement.count({ where }),
    ]);

    return NextResponse.json({
      movements,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("[MOVEMENTS_GET]", error);
    return apiError("Internal server error", 500);
  }
}
