/* ═══════════════════════════════════════════════════════════════
   PAYMENT MATH (pure helpers)
   Single source of truth for the partial-payment (khata/credit)
   rules shared by the POS payment dialog, the checkout service and
   the receipt. Kept free of Prisma/React so the rules are
   unit-testable in isolation (see tests/payment-math.test.ts):

   - the bill is the loyalty-discounted total
   - amountPaid below the bill is ALLOWED only when a customer is
     attached → the shortfall becomes that customer's credit due
   - change is only ever returned on overpayment of the bill
   - paymentStatus drives the Customers-page due list
   ═══════════════════════════════════════════════════════════════ */

export type PaymentStatus = "paid" | "partial" | "unpaid";

export interface PaymentResolution {
  /** Cents actually collected at the register. */
  collected: number;
  /** Cents still owed by the customer (0 when fully paid). */
  dueAmount: number;
  /** Change to hand back (only on overpayment of the bill). */
  changeDue: number;
  /** paid | partial | unpaid — stored on the order. */
  paymentStatus: PaymentStatus;
  /** True when this sale extends store credit (due > 0). */
  isCreditSale: boolean;
}

/**
 * Resolve what the register collects, what becomes credit and what
 * change to return. Server-authoritative: the caller passes the
 * SERVER's final total (post-loyalty), never a client figure.
 *
 * Rules:
 * - Overpayment of the bill → change back, nothing added to credit.
 * - Underpayment WITHOUT a customer → not allowed (caller rejects).
 * - Underpayment WITH a customer → shortfall becomes credit due.
 *   Change and credit can never coexist: the shortfall IS the credit.
 */
export function resolvePayment(
  finalTotalCents: number,
  amountPaidCents: number,
  hasCustomer: boolean
): PaymentResolution {
  const total = Math.max(0, Math.round(finalTotalCents));
  const paid = Math.max(0, Math.round(amountPaidCents));

  if (paid >= total) {
    return {
      collected: total,
      dueAmount: 0,
      changeDue: paid - total,
      paymentStatus: "paid",
      isCreditSale: false,
    };
  }

  // Underpayment: only credit-eligible when a customer is attached.
  if (!hasCustomer) {
    return {
      collected: paid,
      dueAmount: total - paid,
      changeDue: 0,
      paymentStatus: "unpaid",
      isCreditSale: false, // caller must reject — see isPartialPaymentAllowed
    };
  }

  return {
    collected: paid,
    dueAmount: total - paid,
    changeDue: 0,
    paymentStatus: paid > 0 ? "partial" : "unpaid",
    isCreditSale: true,
  };
}

/** Whether the UI may offer/accept a short payment for this sale. */
export function isPartialPaymentAllowed(hasCustomer: boolean): boolean {
  return hasCustomer;
}

/**
 * How a settle-up payment against a customer's outstanding balance
 * splits across their open credit orders. Oldest order first (FIFO)
 * — the oldest debt is the most urgent to clear. Returns the orders
 * to update and the (never negative) leftover advance.
 */
export interface SettleAllocation {
  orderId: string;
  amount: number; // cents applied to this order
  fullySettled: boolean;
}

export function allocateSettlement(
  openOrders: Array<{ id: string; dueAmount: number; createdAt: Date | string }>,
  paymentCents: number
): { allocations: SettleAllocation[]; leftover: number } {
  let remaining = Math.max(0, Math.round(paymentCents));
  const allocations: SettleAllocation[] = [];

  const ordered = [...openOrders].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  for (const o of ordered) {
    if (remaining <= 0) break;
    const due = Math.max(0, Math.round(o.dueAmount));
    if (due <= 0) continue;
    const applied = Math.min(due, remaining);
    allocations.push({
      orderId: o.id,
      amount: applied,
      fullySettled: applied >= due,
    });
    remaining -= applied;
  }

  return { allocations, leftover: remaining };
}

/**
 * After applying `amount` to an order, derive its new payment status.
 * (paidAmount here is the order's cumulative paid cents.)
 */
export function orderStatusAfterSettlement(
  total: number,
  paidAmount: number,
  applied: number
): PaymentStatus {
  const newPaid = paidAmount + Math.max(0, applied);
  if (newPaid >= total) return "paid";
  return newPaid > 0 ? "partial" : "unpaid";
}
