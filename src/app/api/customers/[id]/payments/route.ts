import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api-errors";
import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit-log";
import { requirePermission } from "@/lib/api-auth";
import { allocateSettlement, orderStatusAfterSettlement } from "@/lib/payment-math";
import { applySettlementToCustomer } from "@/lib/customer-balance";

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER PAYMENTS API (khata settlement)
   POST /api/customers/:id/payments — receive a payment against the
   customer's outstanding balance. The amount is allocated FIFO across
   their open credit orders (oldest debt first), each order's
   paidAmount/dueAmount/paymentStatus updated inside one transaction,
   and the customer's outstandingBalance decremented by exactly the
   amount applied to orders (any leftover is an advance and stays on
   the balance as a negative… clamped at zero for simplicity).
   ═══════════════════════════════════════════════════════════════ */

const paymentSchema = z.object({
  /** Payment amount in cents. */
  amount: z.number().int().positive(),
  method: z.enum(["cash", "credit_card", "debit_card", "digital_wallet", "bank_transfer"]).default("cash"),
  notes: z.string().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user, response } = await requirePermission("customers:edit");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();
    const parsed = paymentSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(parsed.error);
    }
    const { amount, method, notes } = parsed.data;

    const result = await db.$transaction(async (tx) => {
      // Lock-ish read: recompute the open dues inside the transaction so
      // two concurrent settlements can't double-apply the same due.
      const customer = await tx.customer.findUnique({
        where: { id },
        select: { id: true, name: true, outstandingBalance: true },
      });
      if (!customer) throw new Error("NOT_FOUND");

      if (customer.outstandingBalance <= 0) {
        throw new Error("NO_DUES");
      }

      const openOrders = await tx.order.findMany({
        where: { customerId: id, dueAmount: { gt: 0 } },
        orderBy: { createdAt: "asc" },
        select: { id: true, dueAmount: true, paidAmount: true, total: true, createdAt: true },
      });

      const { allocations, leftover } = allocateSettlement(openOrders, amount);

      let appliedTotal = 0;
      for (const alloc of allocations) {
        const order = openOrders.find((o) => o.id === alloc.orderId);
        if (!order) continue;

        const newPaid = order.paidAmount + alloc.amount;
        const newDue = Math.max(0, order.dueAmount - alloc.amount);
        // Status comes from the shared rule in lib/payment-math, not a
        // second copy of "newPaid >= total" that could drift from it.
        const status = orderStatusAfterSettlement(order.total, order.paidAmount, alloc.amount);

        await tx.order.update({
          where: { id: alloc.orderId },
          data: {
            paidAmount: newPaid,
            dueAmount: newDue,
            paymentStatus: status,
          },
        });

        // Settlement payment record attached to the order being cleared.
        await tx.payment.create({
          data: {
            orderId: alloc.orderId,
            method,
            amount: alloc.amount,
            status: "completed",
            ...(notes ? { reference: notes } : {}),
          },
        });

        appliedTotal += alloc.amount;
      }

      // The customer's balance drops by everything applied (clamped at
      // zero — a leftover advance is not tracked). Rule: lib/customer-balance.
      const updated = await applySettlementToCustomer(
        tx,
        id,
        appliedTotal,
        customer.outstandingBalance
      );

      return { customer: updated, appliedTotal, leftover, allocations: allocations.length };
    });

    logAudit({
      userId: user.id,
      action: "customer_payment",
      entity: "customer",
      entityId: id,
      entityName: result.customer.name,
      newValues: {
        amount,
        method,
        appliedTotal: result.appliedTotal,
        ordersCleared: result.allocations,
        newBalance: result.customer.outstandingBalance,
      },
      ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });

    return NextResponse.json({
      message: "Payment recorded",
      customer: result.customer,
      appliedTotal: result.appliedTotal,
      leftoverAdvance: result.leftover,
      ordersSettled: result.allocations,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return apiError("Customer not found", 404);
    }
    if (error instanceof Error && error.message === "NO_DUES") {
      return apiError("This customer has no outstanding dues", 409);
    }
    console.error("[CUSTOMER_PAYMENT]", error);
    return apiError("Failed to record payment", 500);
  }
}
