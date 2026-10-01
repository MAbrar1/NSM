/* ═════════════════════ earn-rate.ts — loyalty program constants ═══════════════════
   The loyalty earn rule used to live in three private scopes
   (checkout-service, refund-service, bulk-refund route). One constant
   now feeds all three so changing the program touches exactly one file.

   Rule: 1 point per whole 100 cents ($1) of the order total —
   e.g. $12.50 order → 12 points, $0.99 → 0 points.
   Redemption: 1 point = 1 cent off (see lib/checkout-math).
   ═══════════════════════════════════════════════════════════════ */

/** Cents of spend per 1 loyalty point earned. */
export const LOYALTY_SPEND_PER_POINT = 100;

/**
 * Points earned on an order total (cents). Floor: partial dollars
 * never round up. Single source of truth — checkout earns, full
 * refunds claw back, and the seed's customer rollup all use this.
 */
export function loyaltyPointsForSpend(totalCents: number): number {
  return Math.floor(Math.max(0, totalCents) / LOYALTY_SPEND_PER_POINT);
}
