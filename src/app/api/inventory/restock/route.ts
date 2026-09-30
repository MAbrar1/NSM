import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { creditStock } from "@/lib/inventory/inventory-service";
import { z } from "zod";
import { requirePermission } from "@/lib/api/api-auth";
import { triggerLowStockScan } from "@/lib/inventory/low-stock-scheduler";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   QUICK RESTOCK API
   POST /api/inventory/restock — One-tap stock top-up from the POS
   low-stock strip. Adds `quantity` to the product's stock row in the
   given warehouse (creating the row if missing) and logs a movement.
   Distinct from /api/inventory/adjust: positive-only, no negative or
   damaged/expired flows — the UI intent is "bring stock back".
   ═══════════════════════════════════════════════════════════════ */

const restockSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  quantity: z.number().positive(),
  notes: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("inventory:adjust");
    if (response) return response;

    const body = await request.json();
    const parsed = restockSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(parsed.error);
    }
    const data = parsed.data;

    const result = await db.$transaction(async (tx) => {
      const stockLevel = await tx.stockLevel.findFirst({
        where: { productId: data.productId, warehouseId: data.warehouseId },
        select: { id: true, quantity: true },
      });

      const previousQuantity = stockLevel?.quantity ?? 0;
      const newQuantity = previousQuantity + data.quantity;

      // Stock genuinely arrived, so a missing row is created holding it.
      await creditStock(
        tx,
        { productId: data.productId, warehouseId: data.warehouseId },
        data.quantity,
        "credit-or-create"
      );

      await tx.inventoryMovement.create({
        data: {
          productId: data.productId,
          warehouseId: data.warehouseId,
          type: "adjustment",
          quantity: data.quantity,
          notes: data.notes ?? "Quick restock from POS",
          performedById: user.id,
        },
      });

      return { previousQuantity, newQuantity };
    });

    // Stock just came back — re-run the low-stock scan (cooldown-throttled).
    triggerLowStockScan("restock");

    logAudit({
      userId: user.id,
      action: "stock_adjust",
      entity: "stock_level",
      entityId: data.productId,
      entityName: data.productId,
      oldValues: { quantity: result.previousQuantity },
      newValues: { quantity: result.newQuantity, type: "restock", warehouseId: data.warehouseId },
    });

    return NextResponse.json({
      message: "Stock added successfully",
      previousQuantity: result.previousQuantity,
      newQuantity: result.newQuantity,
    });
  } catch (error) {
    console.error("[QUICK_RESTOCK]", error);
    return apiError("Failed to restock", 500);
  }
}
