/* ═══════════════════════════════════════════════════════════════
   CUSTOMER BALANCE SERVICE
   The single writer for the denormalized Customer columns —
   totalSpent, orderCount, loyaltyPoints and outstandingBalance.

   Those four columns are a CACHE of the order ledger (lib/customer-rollups
   rebuilds them from orders when they drift; lib/verify-consistency
   asserts they agree). Until now the incremental upkeep was spread
   across four sites — checkout-service, refund-service, the order
   cancel route and the khata settlement route — each re-deriving
   which counters move together. One rule per event now lives here:

     sale       → +1 order, +orderTotal spend, ±loyalty, ±new credit
     refund     → −refundAmount spend, write off returned goods' due,
                  and (only on the FIRST full refund) −1 order and a
                  loyalty reversal
     settlement → balance drops by what was applied, clamped at zero
     cancel     → an order nobody keeps sheds its open due

   Every function takes the caller's transaction client so the balance
   always commits or rolls back with the order it describes.
   ═══════════════════════════════════════════════════════════════ */

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** What a khata payment leaves the customer holding. */
export interface SettledCustomer {
  id: string;
  name: string;
  outstandingBalance: number;
}

/**
 * A completed sale. Loyalty earn is `loyaltyEarned` on the pre-redemption
 * total; `loyaltyRedeemed` is burned in the same write.
 *
 * When points are redeemed the write is guarded by
 * `loyaltyPoints >= loyaltyRedeemed` (updateMany) so a concurrent
 * redemption can never drive the balance negative — in which case NO
 * counter moves, exactly as before.
 *
 * `dueAmount − settleApplied` is the change in the customer's running
 * credit: the new shortfall, less any old dues collected at the
 * register in this same transaction. A net zero leaves the column
 * untouched.
 */
export async function applySaleToCustomer(
  tx: Tx,
  params: {
    customerId: string;
    orderTotal: number;
    dueAmount: number;
    settleApplied: number;
    loyaltyEarned: number;
    loyaltyRedeemed: number;
  }
): Promise<void> {
  const balanceDelta = params.dueAmount - params.settleApplied;

  const data = {
    orderCount: { increment: 1 },
    totalSpent: { increment: params.orderTotal },
    loyaltyPoints: { increment: params.loyaltyEarned - params.loyaltyRedeemed },
    ...(balanceDelta !== 0 ? { outstandingBalance: { increment: balanceDelta } } : {}),
  };

  if (params.loyaltyRedeemed > 0) {
    await tx.customer.updateMany({
      where: { id: params.customerId, loyaltyPoints: { gte: params.loyaltyRedeemed } },
      data,
    });
    return;
  }

  await tx.customer.update({ where: { id: params.customerId }, data });
}

/**
 * A refund against an order.
 *
 * - spend drops by the refunded value
 * - `dueWrittenOff` (the part of the refund that ate the order's open
 *   due) comes off the running credit — money the customer no longer
 *   owes for goods they returned
 * - the order count and the loyalty reversal happen ONLY when this
 *   refund completes the order for the first time; a partial refund
 *   leaves the customer holding the discount for what they kept, and a
 *   second refund of an already-fully-refunded order must not
 *   double-count.
 */
export async function applyRefundToCustomer(
  tx: Tx,
  params: {
    customerId: string;
    refundAmount: number;
    dueWrittenOff: number;
    fullyRefundedNow: boolean;
    wasAlreadyFullyRefunded: boolean;
    loyaltyEarned: number;
    loyaltyRedeemed: number;
  }
): Promise<void> {
  const reversesOrder = params.fullyRefundedNow && !params.wasAlreadyFullyRefunded;

  await tx.customer.update({
    where: { id: params.customerId },
    data: {
      totalSpent: { decrement: params.refundAmount },
      ...(params.dueWrittenOff > 0
        ? { outstandingBalance: { decrement: params.dueWrittenOff } }
        : {}),
      ...(reversesOrder
        ? {
            orderCount: { decrement: 1 },
            loyaltyPoints: { increment: params.loyaltyRedeemed - params.loyaltyEarned },
          }
        : {}),
    },
  });
}

/**
 * A khata settlement payment. The balance drops by exactly what was
 * applied to open orders and is clamped at zero: a leftover advance is
 * not tracked, so the balance never goes negative.
 *
 * `currentBalance` is the value the caller read inside the same
 * transaction, so no second read is needed.
 */
export async function applySettlementToCustomer(
  tx: Tx,
  customerId: string,
  appliedTotal: number,
  currentBalance: number
): Promise<SettledCustomer> {
  return tx.customer.update({
    where: { id: customerId },
    data: { outstandingBalance: Math.max(0, currentBalance - appliedTotal) },
    select: { id: true, name: true, outstandingBalance: true },
  });
}

/**
 * A cancelled order releases its open credit: the goods were never
 * kept, so a due against them is money nobody owes. No-op when nothing
 * was owed.
 */
export async function releaseOrderCredit(
  tx: Tx,
  customerId: string,
  dueAmount: number
): Promise<void> {
  if (dueAmount <= 0) return;

  await tx.customer.update({
    where: { id: customerId },
    data: { outstandingBalance: { decrement: dueAmount } },
  });
}
