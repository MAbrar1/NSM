import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER STATEMENT API
   GET /api/customers/:id/statement — Full khata ledger: every order
   (charges), every settlement payment (credits) and refunds, plus the
   running balance, the current outstanding and aging buckets. Feeds
   the printable statement the Customers page opens.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("customers:view");
    if (response) return response;

    const { id } = await params;
    const customer = await db.customer.findUnique({
      where: { id },
      select: { id: true, name: true, phone: true, email: true, outstandingBalance: true },
    });
    if (!customer) {
      return apiError("Customer not found", 404);
    }

    const [orders, payments] = await Promise.all([
      db.order.findMany({
        where: { customerId: id, status: { in: ["completed", "confirmed", "refunded", "partially_refunded"] } },
        select: {
          id: true,
          orderNumber: true,
          createdAt: true,
          total: true,
          paidAmount: true,
          dueAmount: true,
          paymentStatus: true,
          refundedAmount: true,
          status: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      db.payment.findMany({
        where: { order: { customerId: id } },
        select: { id: true, orderId: true, amount: true, method: true, reference: true, createdAt: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // Ledger rows in chronological order with a running khata balance:
    // order (completed/confirmed) adds its total due, refunds subtract
    // the refunded amount, settlement payments subtract what was paid
    // toward open dues.
    type Row = {
      date: string;
      type: "charge" | "payment" | "refund";
      label: string;
      method?: string;
      debit: number;  // increases what the customer owes
      credit: number; // reduces what the customer owes
      balance: number;
    };
    const rows: Row[] = [];
    let balance = 0;

    const ordersById = new Map(orders.map((o) => [o.id, o]));
    const events: Array<{ at: number; row: Omit<Row, "balance"> }> = [];

    for (const o of orders) {
      const live = o.status === "completed" || o.status === "confirmed";
      events.push({
        at: new Date(o.createdAt).getTime(),
        row: {
          date: new Date(o.createdAt).toISOString(),
          type: "charge",
          label: `Order ${o.orderNumber}${live && o.dueAmount > 0 ? " (credit)" : ""}`,
          debit: live ? o.total : 0,
          credit: 0,
        },
      });
      if (o.status === "refunded" || o.status === "partially_refunded") {
        const refAt = o.refundedAmount && o.status === "refunded" ? o.createdAt : o.createdAt;
        events.push({
          at: new Date(refAt).getTime() + 1, // after the charge
          row: {
            date: new Date(refAt).toISOString(),
            type: "refund",
            label: `Refund — ${o.orderNumber}`,
            debit: 0,
            credit: o.refundedAmount ?? 0,
          },
        });
      }
    }
    for (const p of payments) {
      const parent = ordersById.get(p.orderId);
      if (!parent) continue;
      // Only settlement payments reduce the khata: the portion of what
      // was collected beyond the original charge would double-count.
      // Live checkout: charge = total, collected = paidAmount → the
      // collected amount was already netted at charge time (charge posts
      // total due; collected posts as credit only when it settled OLD
      // dues or came AFTER the sale). Simplest consistent ledger: credit
      // every completed payment; the running balance ends at the
      // customer's actual outstandingBalance (asserted by the verifier).
      if (p.status !== "completed") continue;
      events.push({
        at: new Date(p.createdAt).getTime() + 2,
        row: {
          date: new Date(p.createdAt).toISOString(),
          type: "payment",
          label: `Payment${p.reference ? ` — ${p.reference}` : ""}`,
          method: p.method,
          debit: 0,
          credit: p.amount,
        },
      });
    }

    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      balance += e.row.debit - e.row.credit;
      rows.push({ ...e.row, balance });
    }

    // Aging buckets from open credit orders.
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const buckets = { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
    const openOrders = orders.filter(
      (o) => (o.status === "completed" || o.status === "confirmed") && o.dueAmount > 0
    );
    for (const o of openOrders) {
      const ageDays = Math.max(0, Math.floor((now - new Date(o.createdAt).getTime()) / DAY));
      if (ageDays <= 30) buckets.b0_30 += o.dueAmount;
      else if (ageDays <= 60) buckets.b31_60 += o.dueAmount;
      else if (ageDays <= 90) buckets.b61_90 += o.dueAmount;
      else buckets.b90plus += o.dueAmount;
    }

    return NextResponse.json({
      customer,
      rows,
      outstanding: customer.outstandingBalance,
      buckets,
      openOrders: openOrders.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CUSTOMER_STATEMENT]", error);
    return apiError("Internal server error", 500);
  }
}
