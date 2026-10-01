import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { z } from "zod";
import { requirePermission } from "@/lib/api/api-auth";
import {
  clampRefundAmount,
  computeRefundAmount,
  type RefundableLine,
} from "@/lib/refunds/refund-math";
import { applyRefundToOrder } from "@/lib/refunds/refund-service";

/* ═══════════════════════════════════════════════════════════════
   BULK REFUND API
   POST /api/orders/bulk-refund — Refund multiple eligible orders in
   one request. Each order is validated individually (exists, not
   already refunded, not cancelled) and processed inside a shared
   transaction so a failure rolls everything back atomically.

   The per-order refund body is the SHARED pipeline
   (lib/refund-service applyRefundToOrder) — the exact same code path
   as the single-order refund, so the rules (stock restore, movements,
   status transition, negative payment, customer stats + loyalty)
   can never drift apart again.
   ═══════════════════════════════════════════════════════════════ */

const bulkRefundSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(50),
  reason: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Resolve the refunding user from the session — never trust client IDs
    const { user, response } = await requirePermission("orders:refund");
    if (response) return response;

    const body = await request.json();
    const result = bulkRefundSchema.safeParse(body);
    if (!result.success) {
      return apiError("Invalid refund data", 400);
    }

    const { orderIds, reason } = result.data;

    // Load all target orders + their items up front
    const orders = await db.order.findMany({
      where: { id: { in: orderIds } },
      include: { items: true },
    });

    // Per-order eligibility so the response explains every skip
    const byId = new Map(orders.map((o) => [o.id, o]));
    const errors: Array<{ orderId: string; error: string }> = [];
    const eligible: Array<{ id: string; orderNumber: string }> = [];
    for (const id of orderIds) {
      const order = byId.get(id);
      if (!order) {
        errors.push({ orderId: id, error: "Order not found" });
      } else if (order.status === "refunded") {
        errors.push({ orderId: id, error: "Order already refunded" });
      } else if (order.status === "cancelled") {
        errors.push({ orderId: id, error: "Cannot refund a cancelled order" });
      } else {
        eligible.push({ id: order.id, orderNumber: order.orderNumber });
      }
    }

    if (eligible.length === 0) {
      return NextResponse.json(
        { error: "None of the selected orders can be refunded", results: errors },
        { status: 400 }
      );
    }

    const reasonText = reason?.trim() || null;

    // Refund every eligible order inside one transaction. Bulk refunds are
    // always full refunds: whatever has not been returned yet is returned.
    await db.$transaction(async (tx) => {
      for (const target of eligible) {
        const order = byId.get(target.id)!;

        // Resolve the outstanding quantity of every line using the same
        // refund-math helpers as the single-order refund.
        const lineItems: RefundableLine[] = order.items.map((it) => ({
          id: it.id,
          quantity: it.quantity,
          refundedQuantity: it.refundedQuantity || 0,
          total: it.total,
        }));
        const refundQty = new Map<string, number>();
        for (const line of lineItems) {
          const remaining = line.quantity - (line.refundedQuantity || 0);
          if (remaining > 0) refundQty.set(line.id, remaining);
        }
        const refundAmount = clampRefundAmount(
          computeRefundAmount(lineItems, refundQty),
          order.total,
          order.refundedAmount || 0
        );
        if (refundAmount <= 0) continue;

        // Shared refund pipeline — identical rules to processRefund.
        await applyRefundToOrder(tx, order, refundQty, refundAmount, {
          reasonText,
          userId: user.id,
        });
      }
    });

    return NextResponse.json({
      message: `${eligible.length} ${eligible.length === 1 ? "order refunded" : "orders refunded"}`,
      refunded: eligible,
      errors,
    });
  } catch (error) {
    console.error("[ORDER_BULK_REFUND]", error);
    return apiError("Refund failed", 500);
  }
}
