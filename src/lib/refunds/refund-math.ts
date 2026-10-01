/* ═══════════════════════════════════════════════════════════════
   REFUND MATH (pure helpers)
   Single source of truth for refund quantity resolution and value
   proration, shared by the order-refund and bulk-refund API routes.
   Kept free of Prisma so the rules are unit-testable in isolation:

   - remaining qty per line = quantity − already refunded
   - refund value is proportional to the line total, so discounts and
     taxes stay fair when only part of a line is returned:
         lineRefund = round(line.total * qty / line.quantity)
   - an order is "fully refunded" only when every line is back at 100%
   ═══════════════════════════════════════════════════════════════ */

/** A refundable order line (the subset of OrderItem we need). */
export interface RefundableLine {
  id: string;
  quantity: number; // base-unit quantity originally sold
  refundedQuantity?: number | null; // base-unit quantity already returned
  total: number; // line total in cents (incl. discounts + tax)
}

/** One client-requested refund quantity. */
export interface RefundRequestLine {
  id: string;
  quantity: number;
}

export type RefundResolution =
  | { ok: true; refundQty: Map<string, number> }
  | { ok: false; error: string };

/** How much of a line can still be returned (never negative). */
export function lineRemaining(line: RefundableLine): number {
  return Math.max(0, line.quantity - (line.refundedQuantity || 0));
}

/**
 * Decide exactly which lines/quantities to refund.
 * `requested` omitted (or empty) means "full refund of every line that
 * still has outstanding quantity". When `requested` is provided, each
 * entry is validated against the line's remaining quantity.
 */
export function resolveRefundLines(
  lines: RefundableLine[],
  requested?: RefundRequestLine[] | null
): RefundResolution {
  const refundQty = new Map<string, number>();

  if (requested && requested.length > 0) {
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const req of requested) {
      const line = byId.get(req.id);
      if (!line) {
        return { ok: false, error: "Item does not belong to this order" };
      }
      // Accumulate duplicates so a request split across entries is
      // validated against the SUM, not per-entry (previously the last
      // entry silently overwrote earlier ones, hiding over-requests).
      const already = refundQty.get(req.id) ?? 0;
      const avail = lineRemaining(line);
      if (already + req.quantity > avail + 1e-9) {
        return {
          ok: false,
          error: "Refund quantity exceeds the remaining quantity for an item",
        };
      }
      if (req.quantity > 0) refundQty.set(req.id, already + req.quantity);
    }
  } else {
    for (const line of lines) {
      const remaining = lineRemaining(line);
      if (remaining > 0) refundQty.set(line.id, remaining);
    }
  }

  if (refundQty.size === 0) {
    return { ok: false, error: "Nothing to refund — no quantity selected" };
  }

  return { ok: true, refundQty };
}

/**
 * Proportional refunded value of the chosen quantities.
 * E.g. a $12 line (incl. discount/tax) of 2 units refunded 1 unit → $6.
 */
export function computeRefundAmount(
  lines: RefundableLine[],
  refundQty: Map<string, number>
): number {
  let amount = 0;
  for (const [itemId, qty] of refundQty) {
    const line = lines.find((l) => l.id === itemId);
    if (!line || line.quantity <= 0) continue;
    amount += Math.round((line.total * qty) / line.quantity);
  }
  return amount;
}

/** Cap a refund so it never exceeds the order's un-refunded value. */
export function clampRefundAmount(
  amount: number,
  orderTotal: number,
  alreadyRefunded: number
): number {
  return Math.min(amount, orderTotal - (alreadyRefunded || 0));
}

/** Line subset isOrderFullyRefunded needs — callers often query only
 *  these two fields (see the order-refund route) so the full shape is
 *  not required. */
export type RefundProgressLine = Pick<RefundableLine, "quantity" | "refundedQuantity">;

/** True when every line has been fully returned. */
export function isOrderFullyRefunded(lines: RefundProgressLine[]): boolean {
  if (lines.length === 0) return false;
  return lines.every((l) => (l.refundedQuantity || 0) + 1e-9 >= l.quantity);
}
