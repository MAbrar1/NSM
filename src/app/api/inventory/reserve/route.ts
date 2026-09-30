import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { z } from "zod";
import { requirePermission } from "@/lib/api/api-auth";
import { reserveStock, releaseReservation } from "@/lib/inventory/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   STOCK RESERVATION API
   POST /api/inventory/reserve   — Reserve stock for an order
   DELETE /api/inventory/reserve — Release reserved stock
   ═══════════════════════════════════════════════════════════════ */

const reserveSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  // Variant rows carry their own stock — an omitted variantId means the
  // base product row (checkout matches the same way: variantId ?? null).
  variantId: z.string().optional(),
  quantity: z.number().positive(),
  referenceId: z.string().min(1), // Order or cart ID
  referenceType: z.string().default("order"),
});

export async function POST(request: NextRequest) {
  try {
    const { response } = await requirePermission("pos:create_order");
    if (response) return response;

    const body = await request.json();
    const result = reserveSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = result.data;

    // Atomic reserve: the conditional UPDATE re-checks available stock
    // (quantity - reservedQuantity >= requested) under the row's write
    // lock, so two concurrent reservations can never oversell together.
    const stockLevel = await db.stockLevel.findFirst({
      where: {
        productId: data.productId,
        warehouseId: data.warehouseId,
        variantId: data.variantId ?? null,
      },
      select: { id: true, quantity: true, reservedQuantity: true },
    });

    if (!stockLevel) {
      return apiError("Insufficient available stock to reserve", 409);
    }

    const reserved = await reserveStock(
      db,
      stockLevel.id,
      data.quantity,
      stockLevel.reservedQuantity
    );

    if (!reserved) {
      return apiError("Insufficient available stock to reserve", 409);
    }

    return NextResponse.json({ message: "Stock reserved", reserved: data.quantity });
  } catch (error) {
    console.error("[RESERVE_POST]", error);
    return apiError("Internal server error", 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { response } = await requirePermission("pos:create_order");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const productId = searchParams.get("productId") ?? "";
    const warehouseId = searchParams.get("warehouseId") ?? "";
    const quantity = parseFloat(searchParams.get("quantity") ?? "0");
    const referenceId = searchParams.get("referenceId") ?? "";

    if (!productId || !warehouseId || !quantity || !referenceId) {
      return apiError("productId, warehouseId, quantity, and referenceId are required", 400);
    }

    // Never drive reservedQuantity below zero. The decrement is atomic
    // and row-guarded: a read-then-write used to let two concurrent
    // releases (or a release racing the checkout's release) resurrect a
    // reservation from a stale read.
    const variantId = searchParams.get("variantId"); // null ⇒ base product row
    const level = await db.stockLevel.findFirst({
      where: { productId, warehouseId, variantId: variantId ?? null },
      select: { id: true, reservedQuantity: true },
    });
    if (level && level.reservedQuantity > 0) {
      // Conditional release: only applies while reservedQuantity still
      // matches the read — a concurrent change makes the update a no-op
      // (the caller can simply re-release). Rule: lib/inventory-service.
      await releaseReservation(db, level.id, quantity, level.reservedQuantity);
    }

    return NextResponse.json({ message: "Reservation released" });
  } catch (error) {
    console.error("[RESERVE_DELETE]", error);
    return apiError("Internal server error", 500);
  }
}
