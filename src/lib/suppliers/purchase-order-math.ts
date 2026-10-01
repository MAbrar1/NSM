/* ═══════════════════════════════════════════════════════════════
   PURCHASE ORDER MATH (pure helpers)
   Single source of truth for how a PO line and a whole PO are
   priced. The rule used to be retyped four times — twice inside
   POST /api/purchase-orders alone (once for the header totals, once
   again for the item rows it writes, which could drift apart) and
   again in the PO CSV importer. Kept Prisma/Next-free so the
   rounding is unit-testable in isolation.

   Rules:
     lineTotal        = round(quantity × unitCost)
     lineTax          = round(lineTotal × taxRate / 100)
     stored item total = lineTotal + lineTax
     subtotal         = Σ lineTotal
     taxAmount        = Σ lineTax
     total            = subtotal + taxAmount + shippingCost

   Tax is computed on the ROUNDED line amount (never on the raw
   product), so the tax the header reports equals the sum of the tax
   stored on each line.
   ═══════════════════════════════════════════════════════════════ */

/** The pricing inputs of one PO line (fractional quantity allowed). */
export interface PoLineInput {
  quantity: number;
  unitCost: number; // cents per base unit
  taxRate?: number; // percent
}

export interface PoLineTotals {
  /** Rounded pre-tax line amount in cents. */
  lineTotal: number;
  /** Rounded tax on `lineTotal` in cents. */
  lineTax: number;
  /** What a PurchaseOrderItem row stores: lineTotal + lineTax. */
  lineTotalWithTax: number;
}

/** Price one PO line. */
export function poLineTotals(line: PoLineInput): PoLineTotals {
  const lineTotal = Math.round(line.quantity * line.unitCost);
  const lineTax = Math.round((lineTotal * (line.taxRate || 0)) / 100);
  return { lineTotal, lineTax, lineTotalWithTax: lineTotal + lineTax };
}

export interface PoTotals {
  subtotal: number;
  taxAmount: number;
  shippingCost: number;
  total: number;
}

/**
 * Fold every line into the PO header's stored amounts. `shippingCost`
 * defaults to 0 because the CSV importer never sets one.
 */
export function poTotals(lines: PoLineInput[], shippingCost = 0): PoTotals {
  let subtotal = 0;
  let taxAmount = 0;

  for (const line of lines) {
    const { lineTotal, lineTax } = poLineTotals(line);
    subtotal += lineTotal;
    taxAmount += lineTax;
  }

  const shipping = shippingCost || 0;
  return {
    subtotal,
    taxAmount,
    shippingCost: shipping,
    total: subtotal + taxAmount + shipping,
  };
}
