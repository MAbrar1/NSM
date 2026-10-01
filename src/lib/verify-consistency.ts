/* ═══════════════════════════════════════════════════════════════
   CONSISTENCY VERIFIER (shared core)
   Asserts the catalog invariants the UI depends on, straight against
   the database. Used by two entry points:

   - scripts/verify-consistency.ts  → `npm run verify` (CLI, exit code)
   - prisma/seed.ts                 → verifies automatically after seeding

   Checks:
   1. Every tracked product has a base stock row in the default warehouse.
   2. No soft-deleted product still owns live stock rows.
   3. Reserved quantity never exceeds on-hand quantity.
   4. Orders' item sums reconcile with their header totals.
   5. Customer stats (totalSpent / orderCount / loyalty) reconcile
      with their paid orders using the SHARED earn-rate rule.
   6. Every variant belongs to a non-deleted product.
   7. Khata balances match open credit orders.
   8. The restock count is drawn from the catalog (never more items than
      products), and the dashboard counter and the alert engine name the
      same products.
   ═══════════════════════════════════════════════════════════════ */

import { PrismaClient } from "@prisma/client";
import { loyaltyPointsForSpend } from "@/lib/customers/earn-rate";
import { ROLLUP_PAID_STATUSES } from "@/lib/customers/customer-rollups";
import { summarizeLowStock } from "@/lib/inventory/stock-status";
import { openCreditOrderWhere } from "@/lib/reports/report-math";
import { scanLowStock } from "@/lib/inventory/low-stock";

export interface VerifyRow {
  label: string;
  detail: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  okMessage: string;
  problems: VerifyRow[];
}

export interface VerifyResult {
  ok: boolean;
  failedGroups: number;
  checks: VerifyCheck[];
}

export async function verifyConsistency(
  opts: {
    /** When true, log a human-readable report to the console. */
    log?: boolean;
    /** Unused here; kept for API symmetry with the CLI wrapper. */
    exitOnError?: boolean;
  } = {},
  prismaClient?: PrismaClient
): Promise<VerifyResult> {
  const log = opts.log ?? true;
  const prisma = prismaClient ?? new PrismaClient();
  const ownClient = !prismaClient;
  const checks: VerifyCheck[] = [];

  function report(name: string, problems: VerifyRow[], okMessage: string): void {
    checks.push({ name, ok: problems.length === 0, okMessage, problems });
    if (!log) return;
    if (problems.length === 0) {
      console.log(`  ✓ ${name}: ${okMessage}`);
      return;
    }
    console.error(`  ✗ ${name}: ${problems.length} issue(s)`);
    for (const p of problems.slice(0, 10)) {
      console.error(`      · ${p.label}${p.detail ? ` — ${p.detail}` : ""}`);
    }
    if (problems.length > 10) console.error(`      · … and ${problems.length - 10} more`);
  }

  try {
    /* ── 1. Default-warehouse base stock rows ──────────────────── */
    const defaultWh = await prisma.warehouse.findFirst({ where: { isDefault: true } });
    const tracked = await prisma.product.findMany({
      where: { deletedAt: null, trackInventory: true, status: "active" },
      select: { id: true, name: true, sku: true },
    });
    const problems1: VerifyRow[] = [];
    if (defaultWh) {
      const rows = await prisma.stockLevel.findMany({
        where: { warehouseId: defaultWh.id, variantId: null },
        select: { productId: true },
      });
      const withRows = new Set(rows.map((r) => r.productId));
      for (const p of tracked) {
        if (!withRows.has(p.id)) {
          problems1.push({ label: `${p.name} (${p.sku})`, detail: "no base stock row in default warehouse" });
        }
      }
    } else {
      problems1.push({ label: "no default warehouse", detail: "isDefault warehouse missing" });
    }
    report(
      "Default-warehouse stock rows",
      problems1,
      `${tracked.length} tracked products all stocked`
    );

    /* ── 2. No ghost stock for soft-deleted products ───────────── */
    const deletedProducts = await prisma.product.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true },
    });
    const deletedIds = deletedProducts.map((p) => p.id);
    const ghostRows = await prisma.stockLevel.findMany({
      where: { productId: { in: deletedIds.length > 0 ? deletedIds : ["__none__"] } },
      select: { id: true, quantity: true },
    });
    const problems2: VerifyRow[] = ghostRows.map((r) => ({
      label: `stock row ${r.id}`,
      detail: `quantity ${r.quantity} on a deleted product`,
    }));
    report("No ghost stock rows", problems2, "soft-deleted products own no stock");

    /* ── 3. Reserved never exceeds on-hand ─────────────────────── */
    const badReserved = await prisma.stockLevel.findMany({
      where: { reservedQuantity: { gt: 0 } },
      select: { id: true, quantity: true, reservedQuantity: true, product: { select: { sku: true } } },
    });
    const problems3: VerifyRow[] = badReserved
      .filter((r) => r.reservedQuantity > r.quantity)
      .map((r) => ({
        label: r.product.sku,
        detail: `reserved ${r.reservedQuantity} > on-hand ${r.quantity}`,
      }));
    report("Reserved ≤ on-hand", problems3, `${badReserved.length} reserved rows all valid`);

    /* ── 4. Order totals reconcile with their items ────────────── */
    const orders = await prisma.order.findMany({
      select: {
        id: true,
        orderNumber: true,
        subtotal: true,
        taxAmount: true,
        discountAmount: true,
        total: true,
        items: { select: { quantity: true, unitPrice: true, discountAmount: true, taxAmount: true, total: true } },
      },
    });
    const problems4: VerifyRow[] = [];
    for (const o of orders) {
      const itemSub = o.items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
      const itemDisc = o.items.reduce((s, it) => s + (it.discountAmount || 0), 0);
      const itemTax = o.items.reduce((s, it) => s + (it.taxAmount || 0), 0);
      // ±2¢ tolerance per line aggregate for rounding
      if (Math.abs(itemSub - itemDisc - itemTax - o.total) > o.items.length * 2 + 2) {
        problems4.push({
          label: o.orderNumber,
          detail: `items sum ${Math.round(itemSub - itemDisc - itemTax)} vs header ${o.total}`,
        });
      }
    }
    report("Order totals vs items", problems4, `${orders.length} orders reconcile`);

    /* ── 5. Customer stats reconcile (shared earn rule) ────────── */
    const paidStatuses = [...ROLLUP_PAID_STATUSES];
    const customers = await prisma.customer.findMany({
      select: { id: true, name: true, totalSpent: true, orderCount: true, loyaltyPoints: true },
    });
    const orderAgg = await prisma.order.groupBy({
      by: ["customerId"],
      where: { customerId: { not: null }, status: { in: paidStatuses } },
      _sum: { total: true },
      _count: { _all: true },
    });
    const aggMap = new Map(orderAgg.map((a) => [a.customerId!, a]));
    const problems5: VerifyRow[] = [];
    for (const c of customers) {
      const agg = aggMap.get(c.id);
      const spent = agg?._sum.total ?? 0;
      const count = agg?._count._all ?? 0;
      const expectedPoints = loyaltyPointsForSpend(spent);
      if (c.totalSpent !== spent) {
        problems5.push({ label: c.name, detail: `totalSpent ${c.totalSpent} vs orders ${spent}` });
      }
      if (c.orderCount !== count) {
        problems5.push({ label: c.name, detail: `orderCount ${c.orderCount} vs orders ${count}` });
      }
      if (c.loyaltyPoints !== expectedPoints) {
        problems5.push({
          label: c.name,
          detail: `loyalty ${c.loyaltyPoints} vs earn rule ${expectedPoints}`,
        });
      }
    }
    report("Customer stats (shared earn rule)", problems5, `${customers.length} customers reconcile`);

    /* ── 6. Variants belong to live products ───────────────────── */
    const orphanVariants = await prisma.productVariant.count({
      where: { product: { deletedAt: { not: null } } },
    });
    const problems6: VerifyRow[] =
      orphanVariants > 0
        ? [{ label: `${orphanVariants} variants`, detail: "belong to soft-deleted products" }]
        : [];
    report("No orphan variants", problems6, "all variants attached to live products");

    /* ── 7. Khata balances reconcile with open credit orders ───── */
    // A customer's outstandingBalance must equal the sum of the
    // dueAmounts on their live credit orders — otherwise the Customers
    // page, POS balance banner and receipts disagree with the ledger.
    const duesAgg = await prisma.order.groupBy({
      by: ["customerId"],
      // The same open-credit definition the rollup writes from and the
      // dashboard/receivables display — asserted, not re-derived.
      where: { customerId: { not: null }, ...openCreditOrderWhere() },
      _sum: { dueAmount: true },
    });
    const duesMap = new Map(duesAgg.map((d) => [d.customerId!, d._sum.dueAmount ?? 0]));
    const customersWithBalance = await prisma.customer.findMany({
      select: { id: true, name: true, outstandingBalance: true },
    });
    const problems7: VerifyRow[] = [];
    for (const c of customersWithBalance) {
      const expected = duesMap.get(c.id) ?? 0;
      if (c.outstandingBalance !== expected) {
        problems7.push({
          label: c.name,
          detail: `outstandingBalance ${c.outstandingBalance} vs open credit orders ${expected}`,
        });
      }
    }
    report(
      "Khata balances vs open credit orders",
      problems7,
      `${customersWithBalance.length} customers reconcile`
    );

    /* ── 8. Restock count is drawn from the catalog ────────────── */
    // The dashboard renders the catalog size and the restock count side by
    // side, so the restock figure must come from the same product set. Counting
    // stock ROWS rather than distinct products is what once let it report 82
    // against a catalog of 58. The second half asserts the dashboard counter
    // and the alert engine agree — they are two independent code paths that
    // must name exactly the same products as low.
    const trackedCatalog = await prisma.product.findMany({
      where: { status: "active", deletedAt: null, trackInventory: true },
      select: { id: true },
    });
    const catalogIds = new Set(trackedCatalog.map((p) => p.id));

    const restockRows = await prisma.stockLevel.findMany({
      where: {
        variantId: null,
        warehouse: { isActive: true },
        product: { status: "active", deletedAt: null, trackInventory: true },
      },
      select: {
        quantity: true,
        reservedQuantity: true,
        product: { select: { id: true, minStockLevel: true, allowFractional: true } },
      },
    });
    const restock = summarizeLowStock(
      restockRows.map((r) => ({
        productId: r.product.id,
        quantity: r.quantity,
        reservedQuantity: r.reservedQuantity,
        minStockLevel: r.product.minStockLevel,
        allowFractional: r.product.allowFractional,
      }))
    );

    const problems8: VerifyRow[] = [];
    if (restock.total > catalogIds.size) {
      problems8.push({
        label: `${restock.total} needing restock vs ${catalogIds.size} tracked products`,
        detail: "restock count exceeds the catalog — stock rows are being counted as products",
      });
    }
    if (restock.out + restock.low !== restock.total) {
      problems8.push({
        label: "out + low vs total",
        detail: `${restock.out} + ${restock.low} ≠ ${restock.total}`,
      });
    }

    const engineIds = new Set((await scanLowStock()).map((c) => c.productId));
    const onlyOnCard = restock.productIds.filter((id) => !engineIds.has(id));
    const onlyInEngine = [...engineIds].filter((id) => !restock.productIds.includes(id));
    if (onlyOnCard.length > 0 || onlyInEngine.length > 0) {
      problems8.push({
        label: "dashboard counter vs alert engine",
        detail: `${onlyOnCard.length} only on the card, ${onlyInEngine.length} only in the engine`,
      });
    }
    report(
      "Restock count ≤ catalog",
      problems8,
      `${restock.total} of ${catalogIds.size} products need restock (${restock.out} out, ${restock.low} low)`
    );

    const failedGroups = checks.filter((c) => !c.ok).length;
    return { ok: failedGroups === 0, failedGroups, checks };
  } finally {
    // Only disconnect a client this function created — never the caller's.
    if (ownClient) await prisma.$disconnect().catch(() => {});
  }
}
