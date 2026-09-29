import { PrismaClient } from "@prisma/client";

/* ═══════════════════════════════════════════════════════════════
   DEMO SALES SEEDER
   Populates the database with realistic demo activity so the
   dashboard widgets render with real data:
     • Orders spread over the last 7 days × weighted hours
       → revenue trend, sales heatmap, sales-by-hour, recent orders,
         top products, order-status breakdown
     • A few partially-paid (khata) orders → outstanding-dues widget
     • Refunded orders across the last 6 months → refund trend
       + top refund reasons
     • Audit-log entries → "Live activity" feed
   Demo orders use the DEMO- order-number prefix and audit entries
   use a "demo-" entityId prefix, so cleanup never touches real data.

   Usage:
     npx tsx scripts/seed-demo-sales.ts           # seed (skips if present)
     npx tsx scripts/seed-demo-sales.ts --force   # seed on top of existing
     npx tsx scripts/seed-demo-sales.ts --clean   # remove demo data only
   ═══════════════════════════════════════════════════════════════ */

const db = new PrismaClient();
const ORDER_PREFIX = "DEMO-";
const AUDIT_PREFIX = "demo-";

/** Small deterministic PRNG so repeat runs produce the same shape. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(process.env["DEMO_SEED"] ?? 42));
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
const randInt = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

const REFUND_REASONS = [
  "Customer returned item",
  "Damaged / defective product",
  "Wrong item delivered",
  "Quality not as expected",
];

/* Busier around lunch (12–14) and evening (17–21). */
const HOUR_WEIGHTS: Array<[number, number]> = [
  [9, 1], [10, 2], [11, 3], [12, 4], [13, 3], [14, 2], [15, 2],
  [16, 2], [17, 3], [18, 4], [19, 4], [20, 3], [21, 2],
];
function weightedHour(): number {
  const total = HOUR_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [hour, w] of HOUR_WEIGHTS) {
    r -= w;
    if (r <= 0) return hour;
  }
  return 12;
}

const PAYMENT_METHODS: Array<[string, number]> = [
  ["cash", 70], ["credit_card", 10], ["digital_wallet", 10], ["bank_transfer", 5], ["store_credit", 5],
];
function weightedMethod(): string {
  const total = PAYMENT_METHODS.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [method, w] of PAYMENT_METHODS) {
    r -= w;
    if (r <= 0) return method;
  }
  return "cash";
}

async function clean(): Promise<void> {
  const demoOrders = await db.order.findMany({
    where: { orderNumber: { startsWith: ORDER_PREFIX } },
    select: { id: true },
  });
  const ids = demoOrders.map((o) => o.id);
  const payments = ids.length ? await db.payment.deleteMany({ where: { orderId: { in: ids } } }) : { count: 0 };
  const items = ids.length ? await db.orderItem.deleteMany({ where: { orderId: { in: ids } } }) : { count: 0 };
  const orders = ids.length ? await db.order.deleteMany({ where: { id: { in: ids } } }) : { count: 0 };
  const audits = await db.auditLog.deleteMany({ where: { entityId: { startsWith: AUDIT_PREFIX } } });
  console.log(
    `cleaned: ${orders.count} orders, ${items.count} items, ${payments.count} payments, ${audits.count} audit entries`
  );
}

async function seed(): Promise<void> {
  const existing = await db.order.count({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
  if (existing > 0 && !process.argv.includes("--force")) {
    console.log(`demo data already present (${existing} orders) — pass --force to top up, or --clean first`);
    return;
  }

  const user = await db.user.findFirst({
    where: { isActive: true, role: { in: ["super_admin", "admin", "manager"] } },
    orderBy: { role: "asc" },
  });
  if (!user) throw new Error("no active admin/manager user found — seed users first (npm run db:seed)");

  const warehouses = await db.warehouse.findMany({ where: { isActive: true }, orderBy: { isDefault: "desc" } });
  if (warehouses.length === 0) throw new Error("no active warehouse found — seed warehouses first (npm run db:seed)");

  // Weighted warehouse pick: the default location carries ~55% of the
  // traffic so per-warehouse views show realistic, differentiated data.
  const pickWarehouse = (): (typeof warehouses)[number] => {
    if (warehouses.length === 1) return warehouses[0]!;
    if (rand() < 0.55) return warehouses.find((w) => w.isDefault) ?? warehouses[0]!;
    return pick(warehouses);
  };

  const products = await db.product.findMany({
    where: { status: "active", unitPrice: { gt: 0 } },
    select: { id: true, name: true, sku: true, unit: true, unitPrice: true, costPrice: true, taxRate: true },
    take: 12,
    orderBy: { name: "asc" },
  });
  if (products.length === 0) throw new Error("no active products found — seed products first (npm run db:seed)");

  const customers = await db.customer.findMany({ select: { id: true }, take: 3 });

  // Make sure every active warehouse has stock rows for the demo products
  // so per-warehouse low-stock KPIs are meaningful. `update: {}` keeps
  // re-runs idempotent (never overwrites existing/real stock levels).
  for (const wh of warehouses) {
    for (const p of products) {
      const existing = await db.stockLevel.findFirst({
        where: { productId: p.id, variantId: null, warehouseId: wh.id },
        select: { id: true },
      });
      if (!existing) {
        await db.stockLevel.create({
          data: { productId: p.id, variantId: null, warehouseId: wh.id, quantity: randInt(0, 40) },
        });
      }
    }
  }

  const now = new Date();
  const runStamp = Date.now();
  let seq = 0;
  let ordersCreated = 0;
  let auditsCreated = 0;

  const createOrder = async (opts: {
    createdAt: Date;
    status: "completed" | "pending" | "processing" | "refunded";
    refund?: { reason: string; refundedAt: Date };
    withCustomer: boolean;
    partialCredit: boolean;
  }): Promise<void> => {
    seq += 1;
    const lineCount = randInt(1, Math.min(3, products.length));
    const chosen = [...products].sort(() => rand() - 0.5).slice(0, lineCount);

    const items = chosen.map((p) => {
      const quantity = randInt(1, 3);
      const lineTotal = p.unitPrice * quantity;
      const taxAmount = Math.round((lineTotal * (p.taxRate ?? 0)) / 100);
      return {
        productId: p.id,
        productName: p.name,
        sku: p.sku,
        quantity,
        unit: p.unit || "pcs",
        unitPrice: p.unitPrice,
        costPrice: p.costPrice ?? 0,
        taxRate: p.taxRate ?? 0,
        taxAmount,
        total: lineTotal + taxAmount,
      };
    });

    const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    const taxAmount = items.reduce((s, i) => s + i.taxAmount, 0);
    const total = subtotal + taxAmount;

    let paidAmount = total;
    let dueAmount = 0;
    let paymentStatus = "paid";
    if (opts.partialCredit && opts.withCustomer) {
      paidAmount = Math.round(total * (0.4 + rand() * 0.3));
      dueAmount = total - paidAmount;
      paymentStatus = "partial";
    }

    const order = await db.order.create({
      data: {
        orderNumber: `${ORDER_PREFIX}${runStamp}-${String(seq).padStart(3, "0")}`,
        userId: user.id,
        warehouseId: pickWarehouse().id,
        customerId: opts.withCustomer && customers.length ? pick(customers).id : null,
        status: opts.status,
        type: "sale",
        subtotal,
        taxAmount,
        total,
        paidAmount,
        dueAmount,
        paymentStatus,
        notes: "demo data",
        refundReason: opts.refund?.reason ?? null,
        refundedAt: opts.refund?.refundedAt ?? null,
        refundedById: opts.refund ? user.id : null,
        refundedAmount: opts.refund ? total : 0,
        createdAt: opts.createdAt,
        items: { create: items },
        payments:
          paidAmount > 0
            ? {
                create: { method: weightedMethod(), amount: paidAmount, status: "completed", createdAt: opts.createdAt },
              }
            : undefined,
      },
    });
    ordersCreated += 1;

    // Activity-feed entries for recent orders only (keeps the audit log tidy)
    const ageDays = (now.getTime() - opts.createdAt.getTime()) / 86400000;
    if (ageDays <= 2) {
      await db.auditLog.create({
        data: {
          userId: user.id,
          action: "checkout",
          entity: "order",
          entityId: `${AUDIT_PREFIX}${order.id}`,
          entityName: order.orderNumber,
          createdAt: opts.createdAt,
        },
      });
      auditsCreated += 1;
      if (opts.refund) {
        await db.auditLog.create({
          data: {
            userId: user.id,
            action: "refund",
            entity: "order",
            entityId: `${AUDIT_PREFIX}${order.id}`,
            entityName: order.orderNumber,
            createdAt: opts.refund.refundedAt,
          },
        });
        auditsCreated += 1;
      }
    }
  };

  const sprinkleAudit = async (): Promise<void> => {
    const flavors: Array<{ action: string; entity: string; entityName: string }> = [
      { action: "stock_adjust", entity: "stock", entityName: "Stock level adjusted" },
      { action: "stock_transfer", entity: "stock_transfer", entityName: "Warehouse transfer" },
      { action: "customer_payment", entity: "customer", entityName: "Payment received" },
      { action: "create", entity: "product", entityName: "Catalog item" },
      { action: "update", entity: "product", entityName: "Catalog item" },
      { action: "update", entity: "settings", entityName: "Store settings" },
    ];
    for (const flavor of flavors) {
      seq += 1;
      const at = new Date(now.getTime() - randInt(0, 46) * 3600000 - randInt(0, 59) * 60000);
      await db.auditLog.create({
        data: {
          userId: user.id,
          action: flavor.action,
          entity: flavor.entity,
          entityId: `${AUDIT_PREFIX}flavor-${seq}`,
          entityName: flavor.entityName,
          createdAt: at,
        },
      });
      auditsCreated += 1;
    }
  };

  // ── Last 6 days: 7–12 orders per day at weighted hours ──
  for (let daysAgo = 6; daysAgo >= 1; daysAgo--) {
    const count = randInt(7, 12);
    for (let i = 0; i < count; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      d.setHours(weightedHour(), randInt(0, 59), randInt(0, 59), 0);
      await createOrder({
        createdAt: d,
        status: "completed",
        withCustomer: rand() < 0.45,
        partialCredit: rand() < 0.18,
      });
    }
  }

  // ── Today: orders only at hours already past (feeds Sales-by-Hour) ──
  const currentHour = now.getHours();
  if (currentHour >= 10) {
    const todayCount = Math.min(randInt(3, 5), currentHour - 9);
    for (let i = 0; i < todayCount; i++) {
      const d = new Date(now);
      d.setHours(randInt(9, Math.max(10, currentHour - 1)), randInt(0, 59), randInt(0, 59), 0);
      if (d >= now) d.setHours(Math.max(9, currentHour - 1));
      const isLate = i === 0;
      await createOrder({
        createdAt: d,
        status: isLate ? "processing" : rand() < 0.3 ? "pending" : "completed",
        withCustomer: rand() < 0.45,
        partialCredit: rand() < 0.18,
      });
    }
    // One of today's sales gets returned this afternoon → refund activity
    const todaysDemo = await db.order.findFirst({
      where: { orderNumber: { startsWith: ORDER_PREFIX }, createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, total: true, createdAt: true },
    });
    if (todaysDemo) {
      const refundedAt = new Date(now.getTime() - randInt(1, 3) * 3600000);
      const reason = pick(REFUND_REASONS);
      await db.order.update({
        where: { id: todaysDemo.id },
        data: { status: "refunded", refundedAmount: todaysDemo.total, refundedAt, refundedById: user.id, refundReason: reason },
      });
      await db.auditLog.create({
        data: {
          userId: user.id,
          action: "refund",
          entity: "order",
          entityId: `${AUDIT_PREFIX}${todaysDemo.id}`,
          entityName: "DEMO order (today)",
          createdAt: refundedAt,
        },
      });
      auditsCreated += 1;
    }
  }

  // ── Refunded orders across the last 6 months (refund trend + reasons) ──
  for (let monthsAgo = 1; monthsAgo <= 5; monthsAgo++) {
    const count = randInt(1, 2);
    for (let i = 0; i < count; i++) {
      const refundedAt = new Date(now.getFullYear(), now.getMonth() - monthsAgo, randInt(2, 27), randInt(10, 20), randInt(0, 59));
      const createdAt = new Date(refundedAt.getTime() - randInt(1, 3) * 86400000);
      await createOrder({
        createdAt,
        status: "refunded",
        refund: { reason: pick(REFUND_REASONS), refundedAt },
        withCustomer: rand() < 0.5,
        partialCredit: false,
      });
    }
  }

  await sprinkleAudit();

  console.log(
    `seeded ${ordersCreated} demo orders (incl. refunds + khata partials), ${auditsCreated} audit entries — ` +
      `prefix "${ORDER_PREFIX}" / "${AUDIT_PREFIX}"; remove anytime with: npx tsx scripts/seed-demo-sales.ts --clean`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--clean")) {
      await clean();
      return;
    }
    await seed();
  } finally {
    await db.$disconnect();
  }
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
