import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { z } from "zod";
import { requirePermission } from "@/lib/api/api-auth";
import { logAudit } from "@/lib/audit-log";
import { creditStock } from "@/lib/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   TRANSFER STATUS UPDATE
   PUT /api/inventory/transfer/:id — Receive or cancel a transfer.
   ═══════════════════════════════════════════════════════════════ */

const updateSchema = z.object({
  status: z.enum(["received", "cancelled"]),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Resolve the acting user from the session — never trust a client-supplied ID
    const { user, response } = await requirePermission("inventory:transfer");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();
    const result = updateSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const transfer = await db.stockTransfer.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!transfer) {
      return apiError("Transfer not found", 404);
    }

    if (transfer.status !== "pending") {
      return NextResponse.json(
        { error: `Transfer is already ${transfer.status}` },
        { status: 400 }
      );
    }

    const { status } = result.data;
    const performedById = user.id;

    if (status === "received") {
      // Add stock to destination warehouse. Stock rows are matched on
      // variantId exactly (NULL for non-variant lines) so a variant's
      // transfer is credited to the variant's row, never the parent's.
      await db.$transaction(async (tx) => {
        for (const item of transfer.items) {
          // Find or create stock level at destination
          // The goods arrived in the destination warehouse, so the row is
          // created when this warehouse never tracked the product. The
          // increment is atomic (lib/inventory-service), so two receives
          // cannot double-apply a read-then-write.
          await creditStock(
            tx,
            {
              productId: item.productId,
              variantId: item.variantId ?? null,
              warehouseId: transfer.toWarehouseId,
            },
            item.quantity,
            "credit-or-create"
          );

          // Log incoming movement
          await tx.inventoryMovement.create({
            data: {
              productId: item.productId,
              variantId: item.variantId || undefined,
              warehouseId: transfer.toWarehouseId,
              type: "transfer",
              quantity: item.quantity,
              referenceId: transfer.id,
              referenceType: "transfer",
              notes: `Transfer IN from warehouse`,
              performedById,
            },
          });
        }

        await tx.stockTransfer.update({
          where: { id },
          data: { status: "received", receivedAt: new Date() },
        });
      });

      logAudit({
        userId: performedById,
        action: "stock_transfer",
        entity: "stock_transfer",
        entityId: transfer.id,
        entityName: `Transfer ${transfer.id}`,
        newValues: { status: "received" },
      });
    } else {
      // Cancel — return stock to source warehouse
      await db.$transaction(async (tx) => {
        for (const item of transfer.items) {
          // Stock goes back to the source warehouse; a warehouse that never
          // tracked the product is a no-op, never a freshly created row.
          await creditStock(
            tx,
            {
              productId: item.productId,
              variantId: item.variantId ?? null,
              warehouseId: transfer.fromWarehouseId,
            },
            item.quantity
          );

          // Log return movement
          await tx.inventoryMovement.create({
            data: {
              productId: item.productId,
              variantId: item.variantId || undefined,
              warehouseId: transfer.fromWarehouseId,
              type: "adjustment",
              quantity: item.quantity,
              referenceId: transfer.id,
              referenceType: "transfer_cancel",
              notes: `Transfer cancelled — stock returned`,
              performedById,
            },
          });
        }

        await tx.stockTransfer.update({
          where: { id },
          data: { status: "cancelled" },
        });
      });

      logAudit({
        userId: performedById,
        action: "stock_transfer",
        entity: "stock_transfer",
        entityId: transfer.id,
        entityName: `Transfer ${transfer.id}`,
        newValues: { status: "cancelled" },
      });
    }

    return NextResponse.json({ message: `Transfer ${status}` });
  } catch (error) {
    console.error("[TRANSFER_UPDATE]", error);
    return apiError("Internal server error", 500);
  }
}
