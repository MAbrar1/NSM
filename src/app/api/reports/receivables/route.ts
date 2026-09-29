import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { openCreditOrderWhere } from "@/lib/report-math";

/* ═══════════════════════════════════════════════════════════════
   RECEIVABLES AGING API
   GET /api/reports/receivables — Who owes the store money, bucketed
   by how long the credit has been open (0–30 / 31–60 / 61–90 / 90+
   days). Drives the receivables panel on the Customers page and
   gives collections a concrete worklist.
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    const { response } = await requirePermission("customers:view");
    if (response) return response;

    const openOrders = await db.order.findMany({
      // The store's one open-credit definition (lib/report-math), so the
      // worklist cannot disagree with the khata total it is collected from.
      where: { ...openCreditOrderWhere(), customer: { isNot: null } },
      select: {
        customerId: true,
        dueAmount: true,
        createdAt: true,
        customer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    interface Bucket {
      customerId: string;
      name: string;
      phone: string | null;
      total: number;
      orders: number;
      oldestDays: number;
    }
    const byCustomer = new Map<string, Bucket>();
    const buckets = { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    for (const o of openOrders) {
      if (!o.customer) continue;
      const ageDays = Math.max(0, Math.floor((now - new Date(o.createdAt).getTime()) / DAY));

      // Age bucket of THIS order
      if (ageDays <= 30) buckets.b0_30 += o.dueAmount;
      else if (ageDays <= 60) buckets.b31_60 += o.dueAmount;
      else if (ageDays <= 90) buckets.b61_90 += o.dueAmount;
      else buckets.b90plus += o.dueAmount;

      const cur = byCustomer.get(o.customer.id) ?? {
        customerId: o.customer.id,
        name: o.customer.name,
        phone: o.customer.phone ?? null,
        total: 0,
        orders: 0,
        oldestDays: 0,
      };
      cur.total += o.dueAmount;
      cur.orders += 1;
      cur.oldestDays = Math.max(cur.oldestDays, ageDays);
      byCustomer.set(o.customer.id, cur);
    }

    const customers = [...byCustomer.values()].sort(
      (a, b) => b.total - a.total || b.oldestDays - a.oldestDays
    );

    return NextResponse.json({
      total: customers.reduce((s, c) => s + c.total, 0),
      customers,
      buckets,
      orderCount: openOrders.length,
    });
  } catch (error) {
    console.error("[RECEIVABLES_GET]", error);
    return apiError("Internal server error", 500);
  }
}
