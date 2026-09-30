import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit-log";
import { loyaltyPointsForSpend } from "@/lib/customers/earn-rate";
import {
  resolveRefundLines,
  computeRefundAmount,
  clampRefundAmount,
  isOrderFullyRefunded,
  type RefundableLine,
} from "@/lib/refunds/refund-math";
import { applyRefundToCustomer } from "@/lib/customers/customer-balance";
import { creditStock } from "@/lib/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   REFUND SERVICE
   The complete refund pipeline (validation → stock restore →
   movements → ledger → customer stats), extracted from POST
   /api/orders/:id so the real transaction logic can be integration-
   tested against a real database (see tests/refund-integration.test.ts).

   Rules (unchanged from the route):
   - `items` omitted = full refund of every remaining quantity
   - partial refunds pass [{ id, quantity }] in base units
   - per-line refunded value is proportional to the line total
   - the order becomes "refunded" only when every line is fully
     returned; otherwise "partially_refunded"
   ═══════════════════════════════════════════════════════════════ */

/** Refund rejected by a business rule → map `code` to the HTTP status. */
export class RefundError extends Error {
  constructor(
    public code: "not_found" | "invalid_state" | "validation",
    message: string
  ) {
    super(message);
  }
}

const refundItemSchema = z.object({
  id: z.string().min(1),
  quantity: z.number().positive().max(1_000_000),
});

export const refundSchema = z.object({
  reason: z.string().max(500).optional(),
  items: z.array(refundItemSchema).max(100).optional(),
});

export type RefundInput = z.infer<typeof refundSchema>;

/* ────────────────────────────────────────────────────────────────
   SHARED REFUND APPLICATION
   The transaction body below is THE refund pipeline — stock restore,
   return movements, refundedQuantity bookkeeping, order status +
   audit trail, negative payment and customer stats/loyalty. Both the
   single-order route (processRefund) and the bulk-refund route call
   this, so the two paths can never drift apart again (they used to be
   ~120 duplicated lines with subtly different loyalty rules).
   ──────────────────────────────────────────────────────────────── */

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** The order shape applyRefundToOrder needs (order + its items). */
export interface RefundableOrder {
  id: string;
  orderNumber: string;
  warehouseId: string;
  status: string;
  total: number;
  refundedAmount: number | null;
  loyaltyRedeemed: number | null;
  /** Open credit (khata) due on the order — settled by the refund. */
  dueAmount?: number | null;
  customerId: string | null;
  items: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    refundedQuantity: number | null;
    total: number;
  }>;
}

/**
 * Apply a resolved refund inside a transaction and return the new
 * order status. `refundQty` maps order-item id → base-unit quantity to
 * return; `refundAmount` is the (already clamped) value returned.
 */
export async function applyRefundToOrder(
  tx: Tx,
  order: RefundableOrder,
  refundQty: Map<string, number>,
  refundAmount: number,
  opts: { reasonText: string | null; userId: string }
): Promise<"refunded" | "partially_refunded"> {
  const { reasonText, userId } = opts;

  // Restore stock for each returned quantity. Match the variant row
  // exactly (NULL for non-variant lines) so a returned variant sale
  // credits the variant's stock, not the parent product's.
  for (const [itemId, qty] of refundQty) {
    const item = order.items.find((i) => i.id === itemId);
    if (!item || qty <= 0) continue;
    // Atomic increment via lib/inventory-service — a read-then-write could
    // double-apply when two refunds (or a refund racing a PO receive) hit
    // the same row. The default "credit" mode is a no-op when this
    // warehouse never tracked the product, so a refund never conjures a
    // stock row out of nothing.
    await creditStock(
      tx,
      {
        productId: item.productId,
        warehouseId: order.warehouseId,
        variantId: item.variantId ?? null,
      },
      qty
    );

    // Log return movement
    await tx.inventoryMovement.create({
      data: {
        productId: item.productId,
        warehouseId: order.warehouseId,
        type: "return",
        quantity: qty,
        referenceId: order.id,
        referenceType: "refund",
        notes: `Refund for ${order.orderNumber}${reasonText ? `: ${reasonText}` : ""}`,
        performedById: userId,
      },
    });

    // Track how much of this line has been returned (drives remaining-
    // quantity checks + the re-sell flow).
    await tx.orderItem.update({
      where: { id: itemId },
      data: { refundedQuantity: { increment: qty } },
    });
  }

  // Fully refunded only when every line is back at 100% returned
  // (computed from the same lines the refund was resolved against —
  // the bulk route used to guess via `refundAmount > 0`).
  const after: RefundableLine[] = order.items.map((it) => ({
    id: it.id,
    quantity: it.quantity,
    refundedQuantity: (it.refundedQuantity || 0) + (refundQty.get(it.id) ?? 0),
    total: it.total,
  }));
  const newStatus = isOrderFullyRefunded(after) ? "refunded" : "partially_refunded";
  const wasFullyRefunded =
    order.status === "refunded" || (order.refundedAmount || 0) >= order.total;

  // Credit (khata) settlement: the refunded value first eats the order's
  // open due — the customer no longer owes for goods they returned — and
  // only the remainder beyond the due comes back as cash. The balance is
  // written off inside the same transaction so the collections worklist
  // can never keep showing a debt that was refunded away. Works for full
  // and partial refunds, and never drives the balance negative.
  const dueBefore = Math.max(0, order.dueAmount ?? 0);
  const dueWrittenOff = Math.min(dueBefore, refundAmount);
  const dueAfter = dueBefore - dueWrittenOff;
  const cashRefunded = refundAmount - dueWrittenOff;

  // Update order status + refund audit trail (who/when/why)
  await tx.order.update({
    where: { id: order.id },
    data: {
      status: newStatus,
      refundedAmount: { increment: refundAmount },
      refundReason: reasonText,
      refundedAt: new Date(),
      refundedById: userId,
      // The returned goods' due is settled by the refund itself.
      dueAmount: dueAfter,
      paymentStatus: dueAfter <= 0 ? "paid" : undefined,
    },
  });

  // Create refund payment record — mirror the original payment method
  // (or cash when the order has no recorded payment) so the ledger
  // shows the refund went back the way the customer paid. When the
  // order carried an open due, the portion applied to it is written off
  // (no cash moves) and only the over-refund is recorded as money out.
  if (cashRefunded > 0) {
    const originalPayment = await tx.payment.findFirst({
      where: { orderId: order.id, status: "completed", amount: { gt: 0 } },
      orderBy: { createdAt: "asc" },
      select: { method: true },
    });
    await tx.payment.create({
      data: {
        orderId: order.id,
        method: originalPayment?.method ?? "cash",
        amount: -cashRefunded,
        status: "refunded",
        reference: `Refund: ${reasonText ?? "Customer request"}`,
      },
    });
  }

  // Customer stats: spend down by the refunded value, the returned goods'
  // due written off the running credit, and — only on the FIRST full
  // refund — the order uncounted and the loyalty movement reversed. The
  // rule lives in lib/customer-balance alongside the sale-side counterpart.
  if (order.customerId) {
    await applyRefundToCustomer(tx, {
      customerId: order.customerId,
      refundAmount,
      dueWrittenOff,
      fullyRefundedNow: newStatus === "refunded",
      wasAlreadyFullyRefunded: wasFullyRefunded,
      loyaltyEarned: loyaltyPointsForSpend(order.total),
      loyaltyRedeemed: order.loyaltyRedeemed ?? 0,
    });
  }

  return newStatus;
}

export interface RefundActor {
  /** Resolved server-side from the session — never trust client IDs. */
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RefundResult {
  status: "refunded" | "partially_refunded";
  refundedAmount: number;
  orderId: string;
  orderNumber: string;
}

/**
 * Process a full or partial refund: restores stock, logs return
 * movements, writes the negative payment, updates customer stats and
 * loyalty, and logs the audit event. Throws RefundError on any
 * business-rule violation.
 */
export async function processRefund(
  orderId: string,
  input: RefundInput,
  actor: RefundActor
): Promise<RefundResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order) {
    throw new RefundError("not_found", "Order not found");
  }
  if (order.status === "refunded") {
    throw new RefundError("invalid_state", "Order already refunded");
  }
  if (order.status === "cancelled") {
    throw new RefundError("invalid_state", "Cannot refund a cancelled order");
  }

  // Resolve which line quantities to refund. `items` omitted = full refund
  // of every remaining quantity (backwards-compatible). Partial refunds
  // pass [{ id, quantity }] with quantity in the item's base units.
  const lineItems: RefundableLine[] = order.items.map((it) => ({
    id: it.id,
    quantity: it.quantity,
    refundedQuantity: it.refundedQuantity || 0,
    total: it.total,
  }));
  const resolution = resolveRefundLines(lineItems, input.items);
  if (!resolution.ok) {
    throw new RefundError("validation", resolution.error);
  }
  const refundQty = resolution.refundQty;

  // Per-line refunded value is proportional to the line total, so discounts
  // and taxes stay fair when only part of a line is returned.
  const refundAmount = clampRefundAmount(
    computeRefundAmount(lineItems, refundQty),
    order.total,
    order.refundedAmount || 0
  );
  if (refundAmount <= 0) {
    throw new RefundError("validation", "Nothing to refund — amount is zero");
  }

  const reasonText = input.reason?.trim() || null;

  // Process refund: restore stock, log movements, and mark order refunded
  // via the SHARED pipeline (applyRefundToOrder — also used by the
  // bulk-refund route, so the two paths can never drift apart again).
  const newStatus = await db.$transaction((tx) =>
    applyRefundToOrder(tx, order, refundQty, refundAmount, {
      reasonText,
      userId: actor.userId,
    })
  );

  // Log the refund event
  logAudit({
    userId: actor.userId,
    action: "refund",
    entity: "order",
    entityId: order.id,
    entityName: order.orderNumber,
    newValues: {
      refundAmount,
      refundStatus: newStatus,
      reason: reasonText,
      itemCount: refundQty.size,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return {
    status: newStatus,
    refundedAmount: refundAmount,
    orderId: order.id,
    orderNumber: order.orderNumber,
  };
}
