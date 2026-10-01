import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { z } from "zod";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { logAudit } from "@/lib/audit-log";
import { processRefund, refundSchema, RefundError } from "@/lib/refunds/refund-service";
import { releaseOrderCredit } from "@/lib/customers/customer-balance";
import { creditStock } from "@/lib/inventory/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   SINGLE ORDER API
   GET    /api/orders/:id  — Get order with full details
   PUT    /api/orders/:id  — Update order status
   POST   /api/orders/:id  — Process refund
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler<{ id: string }>("ORDER_GET", async (_request, ctx) => {
    const { response } = await requirePermission("orders:view");
    if (response) return response;

    const { id } = await ctx.params;
    const order = await db.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        refundedBy: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, email: true, phone: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, imageUrl: true } },
          },
        },
        payments: true,
      },
    });

    if (!order) {
      return apiError("Order not found", 404);
    }

    return NextResponse.json({ order });
  });

const updateStatusSchema = z.object({
  status: z.enum(["confirmed", "cancelled"]),
});

export const PUT = withApiHandler<{ id: string }>("ORDER_UPDATE", async (request, ctx) => {
    const { user, response } = await requirePermission("orders:manage");
    if (response) return response;

    const { id } = await ctx.params;
    const body = await request.json();
    const result = updateStatusSchema.safeParse(body);

    if (!result.success) {
      return apiError("Invalid status", 400);
    }

    const order = await db.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) {
      return apiError("Order not found", 404);
    }

    if (order.status === "cancelled" || order.status === "refunded" || order.status === "partially_refunded") {
      return NextResponse.json(
        { error: `Cannot update a ${order.status} order` },
        { status: 400 }
      );
    }

    const newStatus = result.data.status;

    // Cancelling an order that already sold (and deducted) stock must give
    // that stock back — otherwise the cancellation silently leaks units.
    // The customer's credit (khata) bookkeeping is settled in the same
    // transaction: an open due on a cancelled order is money nobody owes
    // for goods they never kept, so it must come off their balance and
    // out of the collections worklist. Everything (stock, balance, status)
    // commits or rolls back together.
    if (newStatus === "cancelled" && order.status === "completed") {
      await db.$transaction(async (tx) => {
        // Release any open credit due back off the customer's balance.
        if (order.customerId) {
          await releaseOrderCredit(tx, order.customerId, order.dueAmount);
        }
        for (const item of order.items) {
          // Return the sold units through the one stock writer; a product
          // this warehouse never tracked is a no-op, never a new row.
          await creditStock(
            tx,
            {
              productId: item.productId,
              warehouseId: order.warehouseId,
              variantId: item.variantId ?? null,
            },
            item.quantity
          );
          await tx.inventoryMovement.create({
            data: {
              productId: item.productId,
              warehouseId: order.warehouseId,
              type: "return",
              quantity: item.quantity,
              referenceId: order.id,
              referenceType: "order_cancel",
              notes: `Order ${order.orderNumber} cancelled — stock returned`,
              performedById: user.id,
            },
          });
        }
        await tx.order.update({
          where: { id },
          data: {
            status: newStatus,
            // A cancelled credit sale is no longer collectible.
            ...(order.dueAmount > 0 ? { dueAmount: 0, paymentStatus: "paid" } : {}),
          },
        });
      });
    } else {
      await db.order.update({
        where: { id },
        data: { status: newStatus },
      });
    }

    const updated = await db.order.findUnique({ where: { id } });

    logAudit({
      userId: user.id,
      action: "status_change",
      entity: "order",
      entityId: order.id,
      entityName: order.orderNumber,
      oldValues: { status: order.status },
      newValues: { status: newStatus },
    });

    return NextResponse.json({ order: updated });
  });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Resolve the refunding user from the session — never trust client IDs
    const { user, response } = await requirePermission("orders:refund");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();
    const result = refundSchema.safeParse(body);

    if (!result.success) {
      return apiError("Invalid refund data", 400);
    }

    const outcome = await processRefund(id, result.data, {
      userId: user.id,
      ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });

    return NextResponse.json({
      message: "Refund processed successfully",
      status: outcome.status,
      refundedAmount: outcome.refundedAmount,
    });
  } catch (error) {
    if (error instanceof RefundError) {
      const status =
        error.code === "not_found" ? 404 : error.code === "invalid_state" ? 400 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error("[ORDER_REFUND]", error);
    return apiError("Refund failed", 500);
  }
}
