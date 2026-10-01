/* ═══════════════════════════════════════════════════════════════
   CHECKOUT MATH (pure helpers)
   Single source of truth for the server-authoritative money rules
   enforced by POST /api/pos/checkout. Kept free of Prisma/Next so
   the tamper-rejection rules are unit-testable in isolation (see
   tests/checkout-tampering.test.ts):

   - every line is RECOMPUTED from server prices with the same rules
     as the cart (lib/cart-math): % discount on the subtotal, fixed
     discount per unit, tax on the discounted amount, cents rounded
   - the client's submitted numbers are only COMPARED against the
     recomputed values (±1 cent), so a stale or forged cart fails
     loudly instead of being recorded at wrong prices
   - loyalty redemption is capped by the real balance AND by what is
     actually owed (1 point = 1 cent)
   - payment must cover the final total; change is derived, never
     trusted from the payload
   ═══════════════════════════════════════════════════════════════ */

/** Cents tolerance for client-vs-server money comparisons (1 cent). */
export const MONEY_TOLERANCE = 1;

/** Pricing/stock inputs read from the SERVER's product or variant row. */
export interface ServerPricing {
  unitPrice: number; // cents
  costPrice: number; // cents
  taxRate: number; // percent
}

/** The subset of the client's cart line the reconciliation checks. */
export interface ClientCheckoutLine {
  unitPrice: number; // cents claimed by the client
  costPrice: number; // cents claimed by the client
  quantity: number; // base units (fractional allowed)
  discountType?: "percentage" | "fixed";
  discountValue?: number;
  discountAmount: number; // cents claimed by the client
  taxAmount: number; // cents claimed by the client
  total: number; // cents claimed by the client
}

import { percentToRatio } from "@/lib/money/money";

export type LineReconciliation =
  | {
      ok: true;
      /** Raw (unrounded) line subtotal — order-level sums round once. */
      subtotal: number;
      /** Raw (unrounded) discount — order-level sums round once. */
      discount: number;
      taxAmount: number;
      total: number;
    }
  | { ok: false; error: string };

/**
 * Recompute one line from server prices and compare it with the client's
 * claimed numbers. Error precedence (matches the original route):
 * price → cost → discount/tax/total.
 */
export function reconcileCheckoutLine(
  client: ClientCheckoutLine,
  server: ServerPricing,
  productName: string
): LineReconciliation {
  // Reject a cart whose price doesn't match the catalog — the cashier
  // should refresh, not sell at a stale/wrong (or forged) price.
  if (Math.abs(client.unitPrice - server.unitPrice) > MONEY_TOLERANCE) {
    return {
      ok: false,
      error: `The price of ${productName} has changed. Please refresh the cart and try again.`,
    };
  }
  if (Math.abs(client.costPrice - server.costPrice) > MONEY_TOLERANCE) {
    return {
      ok: false,
      error: `The cost of ${productName} has changed. Please refresh the cart and try again.`,
    };
  }

  // Recompute with the same rules as the cart (see lib/cart-math):
  // % discount on the subtotal, fixed discount per unit, tax on the
  // discounted amount, all rounded to the cent.
  const subtotal = server.unitPrice * client.quantity;
  const discount =
    client.discountType === "percentage"
      ? Math.round(subtotal * percentToRatio(client.discountValue ?? 0))
      : (client.discountValue ?? 0) * client.quantity;
  const afterDiscount = Math.max(0, subtotal - discount);
  const tax = Math.round(afterDiscount * percentToRatio(server.taxRate));
  const total = Math.round(afterDiscount + tax);

  if (
    Math.abs(client.discountAmount - discount) > MONEY_TOLERANCE ||
    Math.abs(client.taxAmount - tax) > MONEY_TOLERANCE ||
    Math.abs(client.total - total) > MONEY_TOLERANCE
  ) {
    return {
      ok: false,
      error: `The total for ${productName} no longer matches. Please refresh the cart and try again.`,
    };
  }

  return { ok: true, subtotal, discount, taxAmount: tax, total };
}

/** Cart-level money as claimed by the client. */
export interface ClientCartTotals {
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
}

/** Cart-level money recomputed on the server (already rounded to cents). */
export interface ServerCartTotals {
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
}

/**
 * Compare the client's cart-level figures with the server's recomputed
 * ones. The client `total` is the PRE-redemption total — loyalty is
 * applied on top server-side, never trusted from the payload.
 */
export function reconcileCartTotals(
  client: ClientCartTotals,
  server: ServerCartTotals
): { ok: true } | { ok: false; error: string } {
  if (
    Math.abs(client.subtotal - server.subtotal) > MONEY_TOLERANCE ||
    Math.abs(client.discountAmount - server.discountAmount) > MONEY_TOLERANCE ||
    Math.abs(client.taxAmount - server.taxAmount) > MONEY_TOLERANCE ||
    Math.abs(client.total - server.total) > MONEY_TOLERANCE
  ) {
    return {
      ok: false,
      error: "Cart totals no longer match. Please refresh the cart and try again.",
    };
  }
  return { ok: true };
}

export type LoyaltyResolution =
  | { ok: true; /** Cents actually discounted. */ cents: number; /** Points burned (== cents). */ points: number }
  | { ok: false; error: string };

/**
 * Resolve a loyalty redemption request (1 point = 1 cent off the total).
 * The requested amount is capped by the customer's REAL balance and by
 * what is actually owed, so a forged payload can never over-spend
 * someone else's points or discount below zero.
 */
export function resolveLoyaltyRedemption(
  requestedPoints: number,
  availablePoints: number,
  orderTotalCents: number,
  hasCustomer: boolean
): LoyaltyResolution {
  if (requestedPoints <= 0) {
    return { ok: true, cents: 0, points: 0 };
  }
  if (!hasCustomer) {
    return { ok: false, error: "Select a customer to redeem loyalty points." };
  }
  if (requestedPoints > availablePoints) {
    return {
      ok: false,
      error: `The customer has ${availablePoints} loyalty points, but ${requestedPoints} were requested.`,
    };
  }
  const maxRedeemableCents = Math.max(0, orderTotalCents);
  const cents = Math.min(requestedPoints, maxRedeemableCents);
  return { ok: true, cents, points: cents }; // cents == points
}

export type PaymentCheck =
  | { ok: true; changeDue: number }
  | { ok: false; error: string };

/**
 * Payment must cover the order — never record a short-paid sale. The
 * change is derived here so the server, not the client, owns it.
 */
export function validatePayment(amountPaid: number, finalTotal: number): PaymentCheck {
  if (amountPaid < finalTotal) {
    return {
      ok: false,
      error: `Amount paid (${amountPaid} cents) is less than the order total (${finalTotal} cents)`,
    };
  }
  return { ok: true, changeDue: amountPaid - finalTotal };
}
