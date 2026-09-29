/* ═══════════════════════════════════════════════════════════════
   CHECKOUT INTEGRATION TESTS (real SQLite via Prisma)
   Exercises the REAL production pipeline (lib/checkout-service) —
   catalog reconciliation, loyalty, payment validation, atomic stock
   deduction, reservation release, movements, payments, customer
   stats — against a throwaway SQLite database.

   Run: npx tsx --test tests/checkout-integration.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./integration/env"; // MUST come before anything that loads @/lib/db
import {
  setupTestDb,
  teardownTestDb,
  cleanTables,
  db,
} from "./integration/db";
import { processCheckout, CheckoutError, type CheckoutInput } from "@/lib/checkout-service";
import { db as prisma } from "@/lib/db";

let harness: Awaited<ReturnType<typeof setupTestDb>> | null = null;

before(async () => {
  harness = await setupTestDb();
});

after(async () => {
  await teardownTestDb();
  harness = null;
});

beforeEach(async () => {
  await cleanTables();
});

/* ─── Shared fixtures ─────────────────────────────────────────── */

let userId = "";
let warehouseId = "";
let productId = "";
let customerId = "";

async function seedBase(opts?: { stock?: number; trackInventory?: boolean }) {
  const user = await db.user.create({
    data: { email: "cashier@test.local", name: "Cashier", password: "x", role: "cashier" },
  });
  userId = user.id;
  const wh = await db.warehouse.create({
    data: { name: "Main", code: "MAIN", isDefault: true, isActive: true },
  });
  warehouseId = wh.id;
  const category = await db.category.create({
    data: { name: "Cat", slug: "cat-" + Math.random().toString(36).slice(2, 8) },
  });
  const product = await db.product.create({
    data: {
      name: "Coffee",
      slug: "coffee-" + Math.random().toString(36).slice(2, 8),
      sku: "SKU-" + Math.random().toString(36).slice(2, 8),
      categoryId: category.id,
      unitPrice: 500,
      costPrice: 300,
      taxRate: 10,
      trackInventory: opts?.trackInventory ?? true,
    },
  });
  productId = product.id;
  if ((opts?.trackInventory ?? true)) {
    await db.stockLevel.create({
      data: { productId, warehouseId, quantity: opts?.stock ?? 10 },
    });
  }
  const customer = await db.customer.create({
    data: { name: "Walk-in", loyaltyPoints: 100 },
  });
  customerId = customer.id;
}

/** Build an honest checkout payload for `qty` units of the fixture product. */
function honestInput(qty: number, overrides?: Partial<CheckoutInput>): CheckoutInput {
  return {
    warehouseId,
    customerId,
    items: [
      {
        productId,
        productName: "Coffee",
        sku: "SKU-X",
        quantity: qty,
        unit: "pcs",
        unitPrice: 500,
        costPrice: 300,
        discountAmount: 0,
        taxRate: 10,
        taxAmount: 50 * qty,
        total: 550 * qty,
      },
    ],
    subtotal: 500 * qty,
    taxAmount: 50 * qty,
    discountAmount: 0,
    total: 550 * qty,
    loyaltyPointsRedeemed: 0,
    paymentMethod: "cash",
    amountPaid: 550 * qty,
    changeDue: 0,
    ...overrides,
  };
}

/* ─── Happy path ──────────────────────────────────────────────── */

test("checkout persists order, items, payment, movement and deducts stock", async () => {
  await seedBase({ stock: 10 });
  const order = await processCheckout(honestInput(2), { userId });

  assert.equal(order.status, "completed");
  assert.equal(order.total, 1100);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0]!.quantity, 2);
  assert.equal(order.payments.length, 1);
  assert.equal(order.payments[0]!.amount, 1100);

  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 8); // 10 − 2

  const movement = await db.inventoryMovement.findFirst({ where: { productId } });
  assert.equal(movement!.quantity, -2);
  assert.equal(movement!.type, "sale");

  const customer = await db.customer.findUnique({ where: { id: customerId } });
  assert.equal(customer!.totalSpent, 1100);
  // 1100 cents = $11 → 11 points earned
  assert.equal(customer!.loyaltyPoints, 100 + 11);
});

/* ─── Tamper rejection ────────────────────────────────────────── */

test("forged unit price is rejected and nothing is persisted", async () => {
  await seedBase({ stock: 10 });
  const input = honestInput(1, {
    items: [
      {
        productId,
        productName: "Coffee",
        sku: "SKU-X",
        quantity: 1,
        unit: "pcs",
        unitPrice: 100, // server price is 500
        costPrice: 300,
        discountAmount: 0,
        taxRate: 10,
        taxAmount: 10,
        total: 110,
      },
    ],
    subtotal: 100,
    taxAmount: 10,
    discountAmount: 0,
    total: 110,
    amountPaid: 110,
  });

  await assert.rejects(
    () => processCheckout(input, { userId }),
    (err: unknown) =>
      err instanceof CheckoutError && err.code === "item_validation"
  );

  assert.equal(await db.order.count(), 0);
  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 10); // untouched
});

test("cart total mismatch is rejected (atomic rollback keeps stock intact)", async () => {
  await seedBase({ stock: 10 });
  // Line is honest but the cart-level total lies.
  const input = honestInput(2, { total: 999, amountPaid: 999 });

  await assert.rejects(
    () => processCheckout(input, { userId }),
    (err: unknown) => err instanceof CheckoutError
  );
  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 10);
});

test("inactive product is rejected", async () => {
  await seedBase({ stock: 10 });
  await db.product.update({ where: { id: productId }, data: { status: "inactive" } });
  await assert.rejects(
    () => processCheckout(honestInput(1), { userId }),
    (err: unknown) =>
      err instanceof CheckoutError &&
      err.message.includes("no longer available")
  );
  assert.equal(await db.order.count(), 0);
});

/* ─── Stock safety ────────────────────────────────────────────── */

test("oversell is rejected atomically — stock untouched, no order", async () => {
  await seedBase({ stock: 3 });
  await assert.rejects(
    () => processCheckout(honestInput(5), { userId }),
    (err: unknown) =>
      err instanceof CheckoutError && err.code === "insufficient_stock"
  );
  assert.equal(await db.order.count(), 0);
  assert.equal(await db.orderItem.count(), 0);
  assert.equal(await db.payment.count(), 0);
  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 3);
});

test("partial multi-line failure rolls the whole order back", async () => {
  await seedBase({ stock: 1 });
  // Second product with zero stock.
  const category = await db.category.findFirst();
  const p2 = await db.product.create({
    data: {
      name: "Tea", slug: "tea-x", sku: "SKU-TEA",
      categoryId: category!.id, unitPrice: 200, costPrice: 100,
      taxRate: 10, // keep the client's honest math in sync
      trackInventory: true,
    },
  });
  await db.stockLevel.create({ data: { productId: p2.id, warehouseId, quantity: 0 } });

  const input = honestInput(1);
  input.items.push({
    productId: p2.id,
    productName: "Tea",
    sku: "SKU-TEA",
    quantity: 1,
    unit: "pcs",
    unitPrice: 200,
    costPrice: 100,
    discountAmount: 0,
    taxRate: 10,
    taxAmount: 20,
    total: 220,
  });
  input.subtotal = 700;
  input.taxAmount = 70;
  input.total = 770;
  input.amountPaid = 770;

  await assert.rejects(
    () => processCheckout(input, { userId }),
    (err: unknown) => err instanceof CheckoutError && err.code === "insufficient_stock"
  );
  // First product's deduction must have rolled back too.
  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 1);
  assert.equal(await db.order.count(), 0);
});

test("untracked product sells without a stock row", async () => {
  await seedBase({ trackInventory: false });
  const order = await processCheckout(honestInput(1), { userId });
  assert.equal(order.status, "completed");
  // No stock row was required for the sale to succeed...
  assert.equal(await db.stockLevel.count({ where: { productId } }), 0);
  // ...but the sale is still written to the movement ledger.
  const movement = await db.inventoryMovement.findFirst({ where: { productId } });
  assert.equal(movement!.quantity, -1);
});

test("reservations are released when the reserved stock is sold", async () => {
  await seedBase({ stock: 5 });
  await db.stockLevel.update({
    where: { id: (await db.stockLevel.findFirst({ where: { productId } }))!.id },
    data: { reservedQuantity: 2, reservedAt: new Date() },
  });
  await processCheckout(honestInput(2), { userId });
  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 3);
  assert.equal(stock!.reservedQuantity, 0);
  assert.equal(stock!.reservedAt, null);
});

/* ─── Loyalty & payment rules ─────────────────────────────────── */

test("loyalty redemption caps at the real balance and updates stats", async () => {
  await seedBase({ stock: 10 });
  // Customer has 100 points; redeem 50 → total 550 − 50 = 500 due.
  const order = await processCheckout(
    honestInput(1, { loyaltyPointsRedeemed: 50, amountPaid: 500 }),
    { userId }
  );
  assert.equal(order.loyaltyRedeemed, 50);
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  // 100 − 50 redeemed + 5 earned (550 cents) = 55
  assert.equal(customer!.loyaltyPoints, 55);
  assert.equal(customer!.totalSpent, 550); // PRE-redemption total
});

test("redeeming more points than the balance is rejected", async () => {
  await seedBase({ stock: 10 });
  await assert.rejects(
    () => processCheckout(honestInput(1, { loyaltyPointsRedeemed: 500, amountPaid: 100 }), { userId }),
    (err: unknown) =>
      err instanceof CheckoutError && err.message.includes("loyalty points")
  );
});

test("short payment without a customer is rejected", async () => {
  await seedBase({ stock: 10 });
  await assert.rejects(
    () => processCheckout(honestInput(1, { amountPaid: 100, customerId: undefined }), { userId }),
    (err: unknown) =>
      err instanceof CheckoutError && err.message.includes("less than the order total")
  );
});

test("short payment with a customer becomes a credit sale (khata)", async () => {
  await seedBase({ stock: 10 });
  // Total is 550; collect 200 → 350 due on the customer's account.
  const order = await processCheckout(
    honestInput(1, { amountPaid: 200 }),
    { userId }
  );
  assert.equal(order.paidAmount, 200);
  assert.equal(order.dueAmount, 350);
  assert.equal(order.paymentStatus, "partial");
  assert.equal(order.changeAmount, 0);

  const customer = await prisma.customer.findUnique({ where: { id: customerId! } });
  assert.equal(customer!.outstandingBalance, 350);

  // Settlement: pay 350 → balance cleared and order fully paid.
  await prisma.order.update({ where: { id: order.id }, data: { dueAmount: 350 } });
  const open = await prisma.order.findFirst({
    where: { customerId: customerId!, dueAmount: { gt: 0 } },
  });
  assert.ok(open);
  const { allocateSettlement, orderStatusAfterSettlement } = await import("@/lib/payment-math");
  const { allocations } = allocateSettlement(
    [{ id: open.id, dueAmount: open.dueAmount, createdAt: open.createdAt }],
    350
  );
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0]!.amount, 350);
  assert.equal(orderStatusAfterSettlement(550, 200, 350), "paid");
});

test("settleOutstanding collects previous khata dues at the register", async () => {
  await seedBase({ stock: 20 });

  // Sale 1: credit sale leaves 350 due on the customer's account.
  await processCheckout(honestInput(1, { amountPaid: 200 }), { userId });
  let customer = await prisma.customer.findUnique({ where: { id: customerId! } });
  assert.equal(customer!.outstandingBalance, 350);

  // Sale 2: pay the new bill in full (550) + collect 200 of the old due.
  const order2 = await processCheckout(
    honestInput(1, { amountPaid: 750, settleOutstanding: 200 }),
    { userId }
  );
  assert.equal(order2.dueAmount, 0);          // new bill fully paid
  assert.equal(order2.paymentStatus, "paid");

  // Balance drops by exactly what was applied to old dues.
  customer = await prisma.customer.findUnique({ where: { id: customerId! } });
  assert.equal(customer!.outstandingBalance, 150);

  // The old order received the settlement payment (FIFO allocation).
  const settledOrder = await prisma.order.findFirst({
    where: { customerId: customerId!, id: { not: order2.id }, dueAmount: { gt: 0 } },
  });
  assert.ok(settledOrder);
  assert.equal(settledOrder.dueAmount, 150);
  assert.equal(settledOrder.paymentStatus, "partial");
  const settlementPayment = await prisma.payment.findFirst({
    where: { orderId: settledOrder.id, amount: 200 },
  });
  assert.ok(settlementPayment);
});

test("settleOutstanding is clamped to what the customer actually owes", async () => {
  await seedBase({ stock: 10 });
  // No prior dues — a settle request must be a harmless no-op, and the
  // new bill still settles at the collected amount.
  const order = await processCheckout(
    honestInput(1, { amountPaid: 550, settleOutstanding: 9999 }),
    { userId }
  );
  assert.equal(order.paidAmount, 550);
  assert.equal(order.dueAmount, 0);
  const customer = await prisma.customer.findUnique({ where: { id: customerId! } });
  assert.equal(customer!.outstandingBalance, 0);
});

test("unknown customer id is rejected with a friendly error", async () => {
  await seedBase({ stock: 10 });
  const input = honestInput(1, { customerId: "does-not-exist" });
  await assert.rejects(
    () => processCheckout(input, { userId }),
    (err: unknown) =>
      err instanceof CheckoutError &&
      err.message.includes("customer does not exist")
  );
});

/* ─── Order-number allocation ─────────────────────────────────── */

test("sequential order numbers are allocated per day", async () => {
  await seedBase({ stock: 10 });
  const o1 = await processCheckout(honestInput(1), { userId });
  const o2 = await processCheckout(honestInput(1), { userId });
  assert.match(o1.orderNumber, /^POS-\d{8}-0001$/);
  assert.match(o2.orderNumber, /^POS-\d{8}-0002$/);
});
