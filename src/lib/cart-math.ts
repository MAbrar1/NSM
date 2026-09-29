/* ═══════════════════════════════════════════════════════════════
   CART MATH (pure helpers)
   Single source of truth for POS line + cart totals, shared by the
   cart store (zustand). Kept free of any store/DOM dependency so the
   rounding rules are unit-testable in isolation:

   - per-line: subtotal = unitPrice × qty
               discount  = % of subtotal | fixed × qty
               after     = max(0, subtotal − discount)
               tax       = round(after × taxRate / 100)
               total     = round(after + tax)
   - cart: subtotal / discount / tax are sums of lines; itemCount
     counts fractional lines as one item (0.385 kg → 1) and whole-unit
     lines as their quantity (2 pcs → 2).
   ═══════════════════════════════════════════════════════════════ */

import type { CartItem, Currency } from "@/types";

export interface LineTotals {
  discountAmount: Currency;
  taxAmount: Currency;
  total: Currency;
}

/** Per-line breakdown for one cart row. Cart totals AND each stored
 *  line's total/discount/tax must come from here so rows, subtotal and
 *  the printed receipt always agree. */
export function lineTotals(item: CartItem, taxRate: number): LineTotals {
  const lineSubtotal = item.unitPrice * item.quantity;
  const discount =
    item.discountType === "percentage"
      ? Math.round(lineSubtotal * (item.discountValue / 100))
      : item.discountValue * item.quantity;
  const afterDiscount = Math.max(0, lineSubtotal - discount);
  const tax = Math.round(afterDiscount * (taxRate / 100));
  return {
    discountAmount: Math.round(discount),
    taxAmount: tax,
    total: Math.round(afterDiscount + tax),
  };
}

/** Attach fresh line totals to every row so stored totals never go stale
 *  after quantity merges, quantity edits or discount changes. */
export function refreshLineTotals(items: CartItem[], taxRate: number): CartItem[] {
  return items.map((item) => ({ ...item, ...lineTotals(item, taxRate) }));
}

export interface CartTotals {
  subtotal: Currency;
  taxAmount: Currency;
  discountAmount: Currency;
  total: Currency;
  itemCount: number;
}

export function calculateCartTotals(items: CartItem[], taxRate: number): CartTotals {
  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let itemCount = 0;

  for (const item of items) {
    const { discountAmount, taxAmount } = lineTotals(item, taxRate);
    subtotal += item.unitPrice * item.quantity;
    totalDiscount += discountAmount;
    totalTax += taxAmount;
    // Fractional cart lines (0.385 kg sugar) count as one item;
    // whole-unit lines still count their full quantity (2 pcs = 2 items).
    itemCount += Math.ceil(item.quantity);
  }

  // Money is integer cents everywhere (line totals are rounded), so the
  // cart subtotal must be too — otherwise total (= subtotal − discount +
  // tax) can drift from the sum of the rounded receipt line totals.
  const roundedSubtotal = Math.round(subtotal);
  return {
    subtotal: roundedSubtotal,
    taxAmount: totalTax,
    discountAmount: totalDiscount,
    total: roundedSubtotal - totalDiscount + totalTax,
    itemCount,
  };
}
