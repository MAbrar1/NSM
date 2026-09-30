/* ═══════════════════════════════════════════════════════════════
   REPORT MATH (pure helpers)
   The arithmetic the report endpoints share. Before this module the
   same expressions were retyped across /api/reports/profit-loss,
   /api/reports/sales and /api/reports/inventory:

     • lineCogs          `costPrice * quantity`            — 3 copies
     • stock valuation   `quantity * costPrice/unitPrice`  — 7 copies
     • gross profit      `revenue - cogs`                  — 5 copies
     • margin percent    `round((rev-cogs)/rev * 100)`     — 3 copies
     • average order     `n > 0 ? round(rev/n) : 0`        — 2 copies
     • net revenue       `total - discount`                — 2 copies

   Two of those (gross profit, net revenue) are the SAME subtraction
   wearing different names, so they share ONE implementation — that is
   exactly how the profit report and the sales report once disagreed
   about a figure a user reasonably expected to match.

   Pure and Prisma-free so the rules are unit-testable in isolation.
   ═══════════════════════════════════════════════════════════════ */

/* ─── What counts as booked revenue ─────────────────────────────
   ONE definition of which order statuses are revenue. It was
   hardcoded as `status: { in: ["completed", "confirmed"] }` in 19
   places — eleven in the dashboard alone, plus every report — while
   lib/customer-rollups exported ROLLUP_PAID_STATUSES whose own
   docstring claimed to be "shared by the dashboard, the reports, the
   Customers page and this rollup". A customer's lifetime spend has
   to equal the revenue the store books, so both sides must read this
   same constant, not a copy of it.

   `revenueStatuses()` returns a fresh mutable array because Prisma's
   generated `in` filter wants string[], not a readonly tuple. */

/** Order statuses that count as booked revenue. */
export const REVENUE_STATUSES = ["completed", "confirmed"] as const;

/** Mutable copy of REVENUE_STATUSES for a Prisma `status: { in: ... }`. */
export function revenueStatuses(): string[] {
  return [...REVENUE_STATUSES];
}

/**
 * The one definition of "a live credit order that still owes money" —
 * status is revenue-bearing AND something is still due.
 *
 * A customer's outstandingBalance must equal the sum of dueAmount over
 * exactly these orders (lib/verify-consistency asserts it). The
 * dashboard's khata card, the receivables report, the customer rollup
 * and the verifier all build their query from this, so the number the
 * store shows as "owed" can never disagree with the worklist it
 * collects from.
 */
export function openCreditOrderWhere(): {
  dueAmount: { gt: number };
  status: { in: string[] };
} {
  return { dueAmount: { gt: 0 }, status: { in: revenueStatuses() } };
}

/* ─── The revenue BASIS ─────────────────────────────────────────
   Revenue is `Order.total` — what the store actually books for the
   sale (subtotal − discount + tax), and the same figure the customer
   ledger accumulates into Customer.totalSpent.

   The P&L used to sum `Order.subtotal` instead, so for one and the
   same period the profit report disagreed with the dashboard, the
   sales report AND the Customers page — while lib/customer-rollups
   documents the invariant that "a customer's lifetime spend must
   equal the revenue the store books" (asserted by
   lib/verify-consistency). `total` is the basis everywhere; revenue
   is therefore gross of tax, with the tax reported separately as
   totalTax — a deliberate reporting choice, not an oversight. */

/**
 * Revenue contributed by one order (cents). Use this rather than
 * reading a field name at the call site, so the basis has one
 * definition and can be changed in one place.
 */
export function revenueOf(order: { total: number }): number {
  return order.total;
}

/** Total revenue of a set of orders (cents) — see revenueOf for the basis. */
export function sumRevenue(orders: Array<{ total: number }>): number {
  let total = 0;
  for (const order of orders) total += revenueOf(order);
  return total;
}

/**
 * Cost of goods sold for ONE sold line, in cents. `costPrice` is the
 * price captured on the order item at sale time, not today's product
 * cost, so historic reports never move when a cost is edited.
 */
export function lineCogs(costPrice: number, quantity: number): number {
  return costPrice * quantity;
}

/** Value of one stock row at cost, in cents (inventory valuation). */
export function stockCostValue(quantity: number, costPrice: number): number {
  return quantity * costPrice;
}

/** Value of one stock row at retail, in cents. */
export function stockRetailValue(quantity: number, unitPrice: number): number {
  return quantity * unitPrice;
}

/**
 * What remains after a deduction, in cents: revenue − COGS (gross
 * profit), revenue − discounts (net revenue), retail − cost (potential
 * profit on stock). One operation, one implementation.
 */
export function netOf(gross: number, deduction: number): number {
  return gross - deduction;
}

/**
 * Gross margin as a whole percent. Zero when there is no revenue —
 * never NaN or a division error on an empty report.
 */
export function marginPercent(revenue: number, cogs: number): number {
  if (revenue <= 0) return 0;
  return Math.round((netOf(revenue, cogs) / revenue) * 100);
}

/** Average order value in cents; zero when the range has no orders. */
export function averageOrderValue(revenue: number, orderCount: number): number {
  if (orderCount <= 0) return 0;
  return Math.round(revenue / orderCount);
}
