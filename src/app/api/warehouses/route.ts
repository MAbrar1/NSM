import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { warehouseSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";

/* ═══════════════════════════════════════════════════════════════
   WAREHOUSES API
   GET  /api/warehouses — List warehouses (any authenticated user)
   POST /api/warehouses — Create a new warehouse (admin only)
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    // Warehouse list is needed by the POS terminal, the header selector,
    // and the inventory screens — auth (any role) is enough here.
    const { response } = await requirePermission();
    if (response) return response;

    const warehouses = await db.warehouse.findMany({
      orderBy: { isDefault: "desc" },
      include: {
        _count: { select: { stockLevels: true } },
      },
    });
    return NextResponse.json({ warehouses });
  } catch (error) {
    console.error("[WAREHOUSES_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { response } = await requirePermission("settings:edit");
    if (response) return response;

    const body = await request.json();
    const result = warehouseSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = result.data;

    // Check for duplicate code
    const existingCode = await db.warehouse.findUnique({ where: { code: data.code } });
    if (existingCode) {
      return fieldError({ code: ["A warehouse with this code already exists"] }, 409);
    }

    // If this is set as default, unset any existing default
    if (data.isDefault) {
      await db.warehouse.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const warehouse = await db.warehouse.create({
      data: {
        name: data.name,
        code: data.code,
        address: data.address || undefined,
        isActive: data.isActive,
        isDefault: data.isDefault,
      },
    });

    return NextResponse.json({ warehouse }, { status: 201 });
  } catch (error) {
    console.error("[WAREHOUSES_POST]", error);
    return apiError("Internal server error", 500);
  }
}
