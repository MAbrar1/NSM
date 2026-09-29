import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { applyStockDelta, ensureStockRow } from "@/lib/inventory-service";
import { z } from "zod";
import { requirePermission } from "@/lib/api-auth";
import { triggerLowStockScan } from "@/lib/low-stock-scheduler";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   STOCK ADJUSTMENT API
   POST /api/inventory/adjust — Adjust stock quantity for a product.
   Creates a movement record and updates stock level.
   ═══════════════════════════════════════════════════════════════ */

const adjustSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  quantity: z.number(), // Positive = add, Negative = remove; fractional OK for weight/volume goods
  type: z.enum(["adjustment", "damaged", "expired", "count", "return"]),
  notes: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Resolve the acting user from the session
    const { user, response } = await requirePermission("inventory:adjust");
    if (response) return response;

    const body = await request.json();
    const result = adjustSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = { ...result.data, performedById: user.id };

    // Find or create stock level
    let stockLevel: { id: string; quantity: number; reservedQuantity: number } | null =
      await db.stockLevel.findFirst({
        where: {
          productId: data.productId,
          warehouseId: data.warehouseId,
        },
        select: { id: true, quantity: true, reservedQuantity: true },
      });

    if (!stockLevel) {
      // Only an ADD may materialize a missing stock row — a removal against
      // a non-existent row is always a negative-stock attempt.
      if (data.quantity < 0) {
        return NextResponse.json(
          { error: `Insufficient stock. Current: 0, Adjustment: ${data.quantity}` },
          { status: 400 }
        );
      }
      const created = await ensureStockRow(db, {
        productId: data.productId,
        warehouseId: data.warehouseId,
      });
      stockLevel = { id: created.id, quantity: 0, reservedQuantity: 0 };
    }

    const newQuantity = stockLevel.quantity + data.quantity;

    if (newQuantity < 0) {
      return NextResponse.json(
        { error: `Insufficient stock. Current: ${stockLevel.quantity}, Adjustment: ${data.quantity}` },
        { status: 400 }
      );
    }

    // Update stock and log movement in transaction. The write re-checks the
    // quantity (WHERE quantity >= -adjustment) so two concurrent removals
    // can't both apply their stale read and drive stock negative.
    await db.$transaction(async (tx) => {
      // Signed delta with the negative guard applied under the row's write
      // lock — see lib/inventory-service.applyStockDelta.
      const applied = await applyStockDelta(tx, stockLevel!.id, data.quantity);
      if (!applied.ok) {
        throw new Error(
          `Insufficient stock. Current: ${stockLevel!.quantity}, Adjustment: ${data.quantity}`
        );
      }

      await tx.inventoryMovement.create({
        data: {
          productId: data.productId,
          warehouseId: data.warehouseId,
          type: data.type,
          quantity: data.quantity,
          notes: data.notes,
          performedById: data.performedById,
        },
      });
    });

    // Damaged/expired adjustments and stock-outs are exactly the moments
    // a low-stock alert matters — check immediately (cooldown-throttled).
    if (data.quantity < 0) triggerLowStockScan("adjust");

    logAudit({
      userId: user.id,
      action: "stock_adjust",
      entity: "stock_level",
      entityId: data.productId,
      entityName: data.productId,
      oldValues: { quantity: stockLevel.quantity },
      newValues: { quantity: newQuantity, type: data.type, warehouseId: data.warehouseId },
    });

    return NextResponse.json({
      message: "Stock adjusted successfully",
      previousQuantity: stockLevel.quantity,
      newQuantity,
      adjustment: data.quantity,
    });
  } catch (error) {
    // Concurrent-removal conflicts are raised as plain Errors inside the
    // transaction (to roll it back) — surface them as 400s, not 500s.
    if (error instanceof Error && /Insufficient stock/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[INVENTORY_ADJUST]", error);
    return apiError("Internal server error", 500);
  }
}
