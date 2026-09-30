/* ═══════════════════════════════════════════════════════════════
   CUSTOMER ROLLUPS (the one place that rebuilds them from the ledger)

   totalSpent / orderCount / loyaltyPoints / outstandingBalance are
   denormalized onto Customer so the Customers list and the POS balance
   banner can render without aggregating the order table each time — but
   the ORDER LEDGER is the truth.

   lib/checkout-service and lib/refund-service keep those columns in step
   incrementally as sales and refunds happen. This module recomputes them
   from scratch instead, which is what we need when the columns have
   already drifted — a partial seed, or an older seed that created the
   customers with zeros and never ran its rollup step, leaves lifetime
   spend and khata balances stuck at 0 while the orders are all there.

   `npm run repair:rollups` (scripts/repair-customer-rollups.ts) calls
   this, and prisma/seed.ts calls it too, so the seeder, the repair tool
   and the verifier all share ONE rule instead of three copies that can
   drift apart.
   ═══════════════════════════════════════════════════════════════ */

import type { PrismaClient } from "@prisma/client";
import { loyaltyPointsForSpend } from "@/lib/customers/earn-rate";
import { REVENUE_STATUSES, openCreditOrderWhere } from "@/lib/report-math";

/**
 * Order statuses that count as revenue.
 *
 * Shared by the dashboard, the reports, the Customers page and this
 * rollup: a customer's lifetime spend must equal the revenue the store
 * books, so both sides have to agree on what "counts". Keep in sync with
 * lib/verify-consistency (which asserts exactly these two properties).
 */
export const ROLLUP_PAID_STATUSES = REVENUE_STATUSES;

/** The values a customer's rollup columns should hold, per the ledger. */
export interface CustomerRollup {
  id: string;
  name: string;
  totalSpent: number;
  orderCount: number;
  loyaltyPoints: number;
  outstandingBalance: number;
}

export interface RollupRepairResult {
  /** Customers examined. */
  checked: number;
  /** Customers whose stored columns disagreed with the ledger (repaired). */
  changed: number;
  /** Customers who still owe money on open credit orders. */
  withDues: number;
  /** The corrected rows (only the ones that actually drifted). */
  updates: CustomerRollup[];
}

/**
 * Recompute every customer's rollup columns from their orders and write
 * back only the rows that drifted. Idempotent: a second run is a no-op.
 *
 * Rules (identical to checkout-service / refund-service and the verifier):
 *   totalSpent         = Σ order.total      where status ∈ PAID
 *   orderCount         = count of those orders
 *   loyaltyPoints      = loyaltyPointsForSpend(totalSpent)   (1 pt / 100¢)
 *   outstandingBalance = Σ order.dueAmount  where dueAmount > 0 and status ∈ PAID
 *
 * Customers are walked in full (not just those with orders) so a customer
 * whose orders were deleted or fully refunded falls back to zero instead of
 * keeping a stale balance the ledger no longer supports.
 */
export async function recomputeCustomerRollups(
  prisma: PrismaClient,
  opts: { log?: boolean } = {}
): Promise<RollupRepairResult> {
  const paid = [...ROLLUP_PAID_STATUSES];

  const spendAgg = await prisma.order.groupBy({
    by: ["customerId"],
    where: { customerId: { not: null }, status: { in: paid } },
    _sum: { total: true },
    _count: { _all: true },
  });
  const duesAgg = await prisma.order.groupBy({
    by: ["customerId"],
    // Same open-credit definition as the dashboard card, the receivables
    // report and the verifier — see lib/report-math.
    where: { customerId: { not: null }, ...openCreditOrderWhere() },
    _sum: { dueAmount: true },
  });

  const spendMap = new Map(
    spendAgg.map((a) => [a.customerId!, { total: a._sum.total ?? 0, count: a._count._all }])
  );
  const duesMap = new Map(duesAgg.map((a) => [a.customerId!, a._sum.dueAmount ?? 0]));

  const customers = await prisma.customer.findMany({
    select: {
      id: true,
      name: true,
      totalSpent: true,
      orderCount: true,
      loyaltyPoints: true,
      outstandingBalance: true,
    },
  });

  const updates: CustomerRollup[] = [];
  let withDues = 0;

  for (const c of customers) {
    const agg = spendMap.get(c.id);
    const totalSpent = agg?.total ?? 0;
    const outstandingBalance = duesMap.get(c.id) ?? 0;
    if (outstandingBalance > 0) withDues++;

    const next: CustomerRollup = {
      id: c.id,
      name: c.name,
      totalSpent,
      orderCount: agg?.count ?? 0,
      loyaltyPoints: loyaltyPointsForSpend(totalSpent),
      outstandingBalance,
    };

    const drift =
      c.totalSpent !== next.totalSpent ||
      c.orderCount !== next.orderCount ||
      c.loyaltyPoints !== next.loyaltyPoints ||
      c.outstandingBalance !== next.outstandingBalance;
    if (!drift) continue;

    updates.push(next);
    if (opts.log) {
      console.log(
        `  · ${c.name}: totalSpent ${c.totalSpent}→${next.totalSpent}, ` +
          `orderCount ${c.orderCount}→${next.orderCount}, ` +
          `loyalty ${c.loyaltyPoints}→${next.loyaltyPoints}, ` +
          `khata ${c.outstandingBalance}→${next.outstandingBalance}`
      );
    }
  }

  for (const u of updates) {
    await prisma.customer.update({
      where: { id: u.id },
      data: {
        totalSpent: u.totalSpent,
        orderCount: u.orderCount,
        loyaltyPoints: u.loyaltyPoints,
        outstandingBalance: u.outstandingBalance,
      },
    });
  }

  return { checked: customers.length, changed: updates.length, withDues, updates };
}
