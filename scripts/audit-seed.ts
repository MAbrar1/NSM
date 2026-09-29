/* Quick data audit for the seeded dev database (run: npx tsx scripts/audit-seed.ts) */
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const [
    poStatus, orderStatus, paymentStatus, orderType, payments, users,
    productStatus, productsNoSupplier, withCompareAt, noTrackInv,
    withImages, withBarcodes, subcategories, inactiveBrands,
    inactiveSuppliers, inactiveCustomers, duesCustomers, transferStatus,
    movementTypes, zeroPays, refundReasons,
  ] = await Promise.all([
    p.purchaseOrder.groupBy({ by: ["status"], _count: true }),
    p.order.groupBy({ by: ["status"], _count: true }),
    p.order.groupBy({ by: ["paymentStatus"], _count: true }),
    p.order.groupBy({ by: ["type"], _count: true }),
    p.payment.groupBy({ by: ["method", "status"], _count: true }),
    p.user.groupBy({ by: ["role", "isActive"], _count: true }),
    p.product.groupBy({ by: ["status"], _count: true }),
    p.product.count({ where: { supplierId: null } }),
    p.product.count({ where: { compareAtPrice: { not: null } } }),
    p.product.count({ where: { trackInventory: false } }),
    p.product.count({ where: { images: { not: null } } }),
    p.product.count({ where: { barcode: { not: null } } }),
    p.category.count({ where: { parentId: { not: null } } }),
    p.brand.count({ where: { isActive: false } }),
    p.supplier.count({ where: { isActive: false } }),
    p.customer.count({ where: { isActive: false } }),
    p.customer.count({ where: { outstandingBalance: { gt: 0 } } }),
    p.stockTransfer.groupBy({ by: ["status"], _count: true }),
    p.inventoryMovement.groupBy({ by: ["type"], _count: true }),
    p.payment.count({ where: { amount: 0 } }),
    p.order.findMany({ where: { refundReason: { not: null } }, select: { refundReason: true }, distinct: ["refundReason"] }),
  ]);

  console.log(JSON.stringify({
    poStatus, orderStatus, paymentStatus, orderType, payments, users,
    productStatus, productsNoSupplier, withCompareAt, noTrackInv,
    withImages, withBarcodes, subcategories, inactiveBrands,
    inactiveSuppliers, inactiveCustomers, duesCustomers, transferStatus,
    movementTypes, zeroPays, refundReasons,
  }, null, 1));

  // Invariant: paid orders must not be underpaid with zero due
  const suspicious = await p.order.findMany({
    where: { paymentStatus: "paid", paidAmount: { lt: 0 } },
    select: { orderNumber: true },
  });
  console.log("negative paidAmount orders:", suspicious.length);

  const underpaidPaid = await p.order.findMany({
    where: { paymentStatus: "paid", status: { in: ["pending", "confirmed"] } },
    select: { orderNumber: true, total: true, paidAmount: true, dueAmount: true },
    take: 500,
  });
  const bad = underpaidPaid.filter((o) => o.paidAmount < o.total && o.dueAmount === 0);
  console.log("underpaid-but-paid-with-zero-due (pending/confirmed):", bad.length);
  console.log(bad.slice(0, 4));

  const refundedCheck = await p.order.findMany({
    where: { status: "refunded" },
    select: { orderNumber: true, total: true, refundedAmount: true, refundedAt: true, refundedById: true, items: { select: { id: true, quantity: true, refundedQuantity: true } } },
    take: 3,
  });
  console.log("sample refunded orders:", JSON.stringify(refundedCheck.map((o) => ({
    n: o.orderNumber, total: o.total, refundedAmount: o.refundedAmount,
    hasRefundedAt: !!o.refundedAt, hasRefundedBy: !!o.refundedById,
    itemRefundedQty: o.items.map((i) => i.refundedQuantity),
  })), null, 1));

  // cancelled orders must not have paid amounts
  const cancelledPaid = await p.order.count({ where: { status: "cancelled", paidAmount: { gt: 0 } } });
  console.log("cancelled orders with paidAmount > 0:", cancelledPaid);

  // unpaid/partial customers stats reconcile check on loyalty
  const pendingPayments = await p.payment.count({ where: { status: "pending" } });
  console.log("pending payments:", pendingPayments);

  await p.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
