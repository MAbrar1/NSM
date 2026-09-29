/* ═══════════════════════════════════════════════════════════════
   SUPPLIER STATS (pure helpers)
   The supplier spend figures the Suppliers list and the supplier
   detail page show. Both endpoints used to re-derive them with the
   same hand-written `purchaseOrders.reduce((acc, po) => acc + po.total, 0)`
   — two copies that would silently disagree the moment one gained a
   status filter the other lacked.

   Derived, never stored: there is no `totalSpent` column on Supplier,
   so the figure always traces back to the purchase-order rows the
   endpoint just read.
   ═══════════════════════════════════════════════════════════════ */

/** Minimal shape of a PurchaseOrder row these helpers accept. */
export interface SupplierPurchaseOrderLike {
  total: number; // cents
}

export interface SupplierPurchaseStats {
  /** Lifetime value of every PO raised against this supplier, in cents. */
  totalSpent: number;
  /** How many POs that figure is made of. */
  totalOrders: number;
}

/** Roll up a supplier's purchase orders into their display stats. */
export function supplierPurchaseStats(
  purchaseOrders: SupplierPurchaseOrderLike[]
): SupplierPurchaseStats {
  let totalSpent = 0;
  for (const po of purchaseOrders) {
    if (Number.isFinite(po.total)) totalSpent += po.total;
  }
  return { totalSpent, totalOrders: purchaseOrders.length };
}
