import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";
import { triggerLowStockScan } from "@/lib/low-stock-scheduler";
import { creditStock } from "@/lib/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   SINGLE PURCHASE ORDER API
   GET /api/purchase-orders/:id  — Full detail
   PUT /api/purchase-orders/:id  — Update status (confirm, receive, cancel)
   ═══════════════════════════════════════════════════════════════ */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("purchase_orders:view");
    if (response) return response;

    const { id } = await params;
    const order = await db.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        warehouse: { select: { id: true, name: true, code: true } },
        createdBy: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, imageUrl: true, unit: true, allowFractional: true, barcode: true } },
          },
        },
        payments: true,
      },
    });

    if (!order) {
      return apiError("Purchase order not found", 404);
    }

    return NextResponse.json({ order });
  } catch (error) {
    console.error("GET /api/purchase-orders/[id] error:", error);
    return apiError("Failed to fetch purchase order", 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { status, receivedQuantities } = body;

    // Receiving goods is a stock-mutating action — require the dedicated
    // receive permission; other transitions need confirm.
    const isReceive = status === "received" || status === "partial";
    const { user, response } = await requirePermission(
      isReceive ? "purchase_orders:receive" : "purchase_orders:confirm"
    );
    if (response) return response;

    const order = await db.purchaseOrder.findUnique({
      where: { id },
      include: { items: true, warehouse: true },
    });

    if (!order) {
      return apiError("Purchase order not found", 404);
    }

    // Status transitions
    const validTransitions: Record<string, string[]> = {
      draft: ["pending", "cancelled"],
      pending: ["ordered", "cancelled"],
      ordered: ["partial", "received", "cancelled"],
      partial: ["received", "cancelled"],
      received: [],
      cancelled: [],
    };

    if (status && !(validTransitions[order.status]?.includes(status) ?? false)) {
      return NextResponse.json(
        { error: `Cannot transition from ${order.status} to ${status}` },
        { status: 400 }
      );
    }

    // Handle receiving goods — fully transactional so stock, item received
    // quantities, movements and the status change can never drift apart.
    if (status === "received" || status === "partial") {
      // Resolve per-line quantities to receive now (base units). Defaults to
      // whatever is still outstanding; never more than that.
      const receiveMap = new Map<string, number>();
      for (const item of order.items) {
        const outstanding = item.quantity - item.receivedQty;
        const requested = receivedQuantities?.[item.id] ?? outstanding;
        if (!Number.isFinite(requested) || requested <= 0) continue;
        if (requested > outstanding + 1e-9) {
          return NextResponse.json(
            { error: `Received quantity for ${item.productName} exceeds the outstanding quantity (${outstanding})` },
            { status: 400 }
          );
        }
        receiveMap.set(item.id, requested);
      }

      if (receiveMap.size === 0) {
        return apiError("Nothing to receive — no outstanding quantity selected", 400);
      }

      let finalStatus: string;
      await db.$transaction(async (tx) => {
        for (const item of order.items) {
          const receivedQty = receiveMap.get(item.id);
          if (!receivedQty) continue;

          // Update PO item received quantity
          await tx.purchaseOrderItem.update({
            where: { id: item.id },
            data: { receivedQty: { increment: receivedQty } },
          });

          // Received goods land in stock through the one stock writer;
          // the row is created when the receiving warehouse has none yet.
          await creditStock(
            tx,
            {
              productId: item.productId,
              warehouseId: order.warehouseId,
              variantId: null,
            },
            receivedQty,
            "credit-or-create"
          );

          // Log inventory movement
          await tx.inventoryMovement.create({
            data: {
              productId: item.productId,
              warehouseId: order.warehouseId,
              type: "po_receive",
              quantity: receivedQty,
              referenceId: order.id,
              referenceType: "PurchaseOrder",
              notes: `Received ${receivedQty} units from PO ${order.orderNumber}`,
              performedById: user.id,
            },
          });
        }

        // All items fully received → "received", otherwise "partial"
        const after = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: order.id },
          select: { quantity: true, receivedQty: true },
        });
        const allReceived = after.every((it) => it.receivedQty + 1e-9 >= it.quantity);
        finalStatus = allReceived ? "received" : "partial";

        await tx.purchaseOrder.update({
          where: { id },
          data: {
            status: finalStatus,
            // Stamp the completion time on the final receive only; a partial
            // receive must not wipe a previously recorded timestamp.
            ...(allReceived ? { receivedAt: new Date() } : {}),
          },
        });
      });

      const updated = await db.purchaseOrder.findUnique({
        where: { id },
        include: {
          supplier: { select: { name: true } },
          warehouse: { select: { name: true } },
          items: true,
        },
      });

      // Goods just landed — if a partial delivery still leaves an item below
      // its minimum, alert right away (cooldown-throttled).
      triggerLowStockScan("po-receive");

      logAudit({
        userId: user.id,
        action: "update",
        entity: "purchase_order",
        entityId: order.id,
        entityName: order.orderNumber,
        newValues: {
          status: finalStatus!,
          receivedLines: receiveMap.size,
          receivedQty: [...receiveMap.values()].reduce((s, q) => s + q, 0),
        },
      });

      return NextResponse.json({ order: updated });
    }

    // Simple status update (draft→pending, cancelled, etc.) — a missing or
    // invalid status must be rejected here, not handed to Prisma as undefined.
    if (!status || !(status in validTransitions)) {
      return apiError("Invalid status", 400);
    }
    const updated = await db.purchaseOrder.update({
      where: { id },
      data: { status },
      include: {
        supplier: { select: { name: true } },
        warehouse: { select: { name: true } },
        items: true,
      },
    });

    return NextResponse.json({ order: updated });
  } catch (error) {
    console.error("PUT /api/purchase-orders/[id] error:", error);
    return apiError("Failed to update purchase order", 500);
  }
}
