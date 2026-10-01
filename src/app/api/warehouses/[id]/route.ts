import { NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { warehouseSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";

/* ═══════════════════════════════════════════════════════════════
   SINGLE WAREHOUSE API
   GET    /api/warehouses/:id — Get warehouse with stock summary
   PUT    /api/warehouses/:id — Update warehouse
   DELETE /api/warehouses/:id — Soft-delete warehouse
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler<{ id: string }>("WAREHOUSE_GET", async (_request, ctx) => {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const { id } = await ctx.params;
    const warehouse = await db.warehouse.findUnique({
      where: { id },
      include: {
        _count: { select: { stockLevels: true } },
        stockLevels: {
          include: {
            product: {
              select: { id: true, name: true, sku: true, costPrice: true, unitPrice: true, unit: true },
            },
          },
          orderBy: { quantity: "desc" },
          take: 50,
        },
      },
    });

    if (!warehouse) {
      return apiError("Warehouse not found", 404);
    }

    // Compute stock value
    const totalStockValue = warehouse.stockLevels.reduce(
      (sum, sl) => sum + sl.quantity * sl.product.costPrice,
      0
    );

    return NextResponse.json({ warehouse: { ...warehouse, totalStockValue } });
  });

export const PUT = withApiHandler<{ id: string }>("WAREHOUSE_PUT", async (request, ctx) => {
    const { response } = await requirePermission("settings:edit");
    if (response) return response;

    const { id } = await ctx.params;
    const body = await request.json();
    const result = warehouseSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const existing = await db.warehouse.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Warehouse not found", 404);
    }

    const data = result.data;

    // Check code uniqueness
    if (data.code !== existing.code) {
      const codeConflict = await db.warehouse.findUnique({ where: { code: data.code } });
      if (codeConflict) {
        return apiError("A warehouse with this code already exists", 409);
      }
    }

    // If this is set as default, unset any existing default
    if (data.isDefault && !existing.isDefault) {
      await db.warehouse.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const warehouse = await db.warehouse.update({
      where: { id },
      data: {
        name: data.name,
        code: data.code,
        address: data.address || undefined,
        isActive: data.isActive,
        isDefault: data.isDefault,
      },
    });

    return NextResponse.json({ warehouse });
  });

export const DELETE = withApiHandler<{ id: string }>("WAREHOUSE_DELETE", async (_request, ctx) => {
    const { response } = await requirePermission("settings:edit");
    if (response) return response;

    const { id } = await ctx.params;
    const existing = await db.warehouse.findUnique({
      where: { id },
      include: {
        _count: { select: { stockLevels: true, orders: true, purchaseOrders: true } },
      },
    });

    if (!existing) {
      return apiError("Warehouse not found", 404);
    }

    if (existing.isDefault) {
      return apiError("Cannot delete the default warehouse. Set another warehouse as default first.", 409);
    }

    if (existing._count.orders > 0) {
      return apiError("Cannot delete warehouse with order history. Deactivate it instead.", 409);
    }

    if (existing._count.stockLevels > 0) {
      return apiError("Cannot delete warehouse with stock on hand. Transfer or remove its stock first.", 409);
    }

    await db.warehouse.delete({ where: { id } });

    return NextResponse.json({ message: "Warehouse deleted" });
  });
