/* ═══════════════════════════════════════════════════════════════
   REFUND INTEGRATION TESTS (real SQLite via Prisma)
   Exercises the REAL production pipeline (lib/refund-service):
   full & partial refunds, proportional value, stock restoration,
   movements, negative payment records, customer stats & loyalty
   reversal, and multi-pass refund accumulation.

   Run: npx tsx --test tests/refund-integration.test.ts
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
import { processRefund, RefundError } from "@/lib/refund-service";

let harness: Awaited<ReturnType<typeof setupTestDb>> | null = null;

before(async () => {
  harness = await setupTestDb();
});

after(async () => {
  if (harness) await teardownTestDb();
});

beforeEach(async () => {
  await cleanTables();
});

/* ─── Fixture: a completed sale with stock deducted ───────────── */

let userId = "";
let warehouseId = "";
let productId = "";
let customerId = "";
let orderId = "";

interface SeedOptions {
  qty?: number;
  unitPrice?: number; // cents
  loyaltyRedeemed?: number; // cents
}

async function seedSoldOrder(opts: SeedOptions = {}) {
  const qty = opts.qty ?? 2;
  const unitPrice = opts.unitPrice ?? 500;
  const subtotal = unitPrice * qty;
  const taxAmount = Math.round(subtotal * 0.1);
  const total = subtotal + taxAmount;

  const user = await db.user.create({
    data: { email: "cashier@test.local", name: "Cashier", password: "x", role: "cashier" },
  });
  userId = user.id;
  const wh = await db.warehouse.create({
    data: { name: "Main", code: "MAIN", isActive: true },
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
      unitPrice,
      costPrice: 300,
      taxRate: 10,
      trackInventory: true,
    },
  });
  productId = product.id;
  // The sale already happened: stock is post-sale.
  await db.stockLevel.create({
    data: { productId, warehouseId, quantity: 8 },
  });
  const customer = await db.customer.create({
    data: { name: "Alice", loyaltyPoints: opts.loyaltyRedeemed ?? 0 },
  });
  customerId = customer.id;

  const order = await db.order.create({
    data: {
      orderNumber: "POS-20260918-0001",
      customerId,
      userId,
      warehouseId,
      status: "completed",
      type: "sale",
      subtotal,
      taxAmount,
      discountAmount: 0,
      total,
      paidAmount: total,
      loyaltyRedeemed: opts.loyaltyRedeemed ?? 0,
      loyaltyPointsRedeemed: opts.loyaltyRedeemed ?? 0,
    },
  });
  orderId = order.id;
  await db.orderItem.create({
    data: {
      orderId,
      productId,
      productName: "Coffee",
      sku: "SKU-X",
      quantity: qty,
      unit: "pcs",
      unitPrice,
      costPrice: 300,
      taxRate: 10,
      taxAmount,
      total,
    },
  });
  await db.payment.create({
    data: { orderId, method: "cash", amount: total, status: "completed" },
  });

  return { order, total };
}

/* ─── Full refunds ────────────────────────────────────────────── */

test("full refund restores stock, writes movement + negative payment", async () => {
  const { total } = await seedSoldOrder({ qty: 2 });
  const result = await processRefund(orderId, { reason: "changed mind" }, { userId });

  assert.equal(result.status, "refunded");
  assert.equal(result.refundedAmount, total);

  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 10); // 8 + 2 back

  const movement = await db.inventoryMovement.findFirst({
    where: { productId, type: "return" },
  });
  assert.equal(movement!.quantity, 2);
  assert.equal(movement!.referenceType, "refund");

  const refundPayment = await db.payment.findFirst({
    where: { orderId, status: "refunded" },
  });
  assert.equal(refundPayment!.amount, -total);
  assert.equal(refundPayment!.method, "cash"); // mirrors the original method

  const order = await db.order.findUnique({ where: { id: orderId } });
  assert.equal(order!.status, "refunded");
  assert.equal(order!.refundedAmount, total);
  assert.equal(order!.refundedById, userId);
});

test("order items are marked refunded so re-sell flow sees remaining = 0", async () => {
  await seedSoldOrder({ qty: 3 });
  await processRefund(orderId, {}, { userId });
  const item = await db.orderItem.findFirst({ where: { orderId } });
  assert.equal(item!.refundedQuantity, 3);
});

/* ─── Partial refunds ─────────────────────────────────────────── */

test("partial refund is proportional and keeps status partially_refunded", async () => {
  // 2 units at 550 each (incl. tax) → refund 1 unit = 550.
  await seedSoldOrder({ qty: 2, unitPrice: 500 });
  const item = await db.orderItem.findFirst({ where: { orderId } });

  const result = await processRefund(
    orderId,
    { items: [{ id: item!.id, quantity: 1 }] },
    { userId }
  );

  assert.equal(result.status, "partially_refunded");
  assert.equal(result.refundedAmount, 550);

  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 9); // 8 + 1

  const order = await db.order.findUnique({ where: { id: orderId } });
  assert.equal(order!.status, "partially_refunded");
  assert.equal(order!.refundedAmount, 550);

  const customer = await db.customer.findUnique({ where: { id: customerId } });
  assert.equal(customer!.totalSpent, -550); // decrement only; started at 0
  assert.equal(customer!.orderCount, 0); // unchanged on partial refunds
});

test("two partial passes accumulate to a full refund", async () => {
  await seedSoldOrder({ qty: 2, unitPrice: 500 });
  const item = await db.orderItem.findFirst({ where: { orderId } });

  const pass1 = await processRefund(
    orderId,
    { items: [{ id: item!.id, quantity: 1 }] },
    { userId }
  );
  assert.equal(pass1.status, "partially_refunded");
  assert.equal(pass1.refundedAmount, 550);

  const pass2 = await processRefund(
    orderId,
    { items: [{ id: item!.id, quantity: 1 }] },
    { userId }
  );
  assert.equal(pass2.status, "refunded");
  assert.equal(pass2.refundedAmount, 550);

  const order = await db.order.findUnique({ where: { id: orderId } });
  assert.equal(order!.refundedAmount, 1100);
  const stock = await db.stockLevel.findFirst({ where: { productId } });
  assert.equal(stock!.quantity, 10);
});

test("over-refund of a line is rejected", async () => {
  await seedSoldOrder({ qty: 2 });
  const item = await db.orderItem.findFirst({ where: { orderId } });
  await assert.rejects(
    () =>
      processRefund(
        orderId,
        { items: [{ id: item!.id, quantity: 3 }] },
        { userId }
      ),
    (err: unknown) =>
      err instanceof RefundError && err.code === "validation"
  );
});

/* ─── State guards ────────────────────────────────────────────── */

test("already refunded order is rejected", async () => {
  await seedSoldOrder({ qty: 1 });
  await processRefund(orderId, {}, { userId });
  await assert.rejects(
    () => processRefund(orderId, {}, { userId }),
    (err: unknown) =>
      err instanceof RefundError && err.message.includes("already refunded")
  );
});

test("unknown order id is rejected with not_found", async () => {
  await assert.rejects(
    () => processRefund("no-such-order", {}, { userId }),
    (err: unknown) => err instanceof RefundError && err.code === "not_found"
  );
});

test("item from another order is rejected", async () => {
  await seedSoldOrder({ qty: 1 });
  // A second order with its own item.
  const other = await db.order.create({
    data: {
      orderNumber: "POS-20260918-0002",
      userId,
      warehouseId,
      status: "completed",
      type: "sale",
      total: 100,
    },
  });
  const otherItem = await db.orderItem.create({
    data: {
      orderId: other.id,
      productId,
      productName: "Coffee",
      sku: "SKU-X",
      quantity: 1,
      unit: "pcs",
      unitPrice: 100,
      costPrice: 50,
      total: 100,
    },
  });
  await assert.rejects(
    () =>
      processRefund(
        orderId,
        { items: [{ id: otherItem.id, quantity: 1 }] },
        { userId }
      ),
    (err: unknown) =>
      err instanceof RefundError && err.message.includes("does not belong")
  );
});

/* ─── Customer stats & loyalty reversal ───────────────────────── */

test("full refund reverses loyalty earn/redeem and order count", async () => {
  // Sale: total 1100 → earned 11 points; customer redeemed 40 at checkout.
  await seedSoldOrder({ qty: 2, loyaltyRedeemed: 40 });
  // Balance as it stands post-sale: earned 11, spent 40 → start at -29 + 40 given = 11.
  await db.customer.update({
    where: { id: customerId },
    data: { loyaltyPoints: 11, totalSpent: 1100, orderCount: 1 },
  });

  await processRefund(orderId, {}, { userId });

  const customer = await db.customer.findUnique({ where: { id: customerId } });
  // Full refund: loyalty = 11 + (redeemed 40 − earned 11) = 40 → back to pre-sale.
  assert.equal(customer!.loyaltyPoints, 40);
  assert.equal(customer!.totalSpent, 0);
  assert.equal(customer!.orderCount, 0);
});

test("variant sale refunds the variant's stock row, not the parent's", async () => {
  await seedSoldOrder({ qty: 1 });
  // Turn the line into a variant line manually: create variant + variant
  // stock rows and repoint the order item.
  const variant = await db.productVariant.create({
    data: {
      productId,
      name: "1kg",
      sku: "SKU-V1",
      unitPrice: 500,
      costPrice: 300,
      isActive: true,
    },
  });
  await db.stockLevel.create({
    data: { productId, variantId: variant.id, warehouseId, quantity: 4 },
  });
  await db.orderItem.updateMany({
    where: { orderId },
    data: { variantId: variant.id },
  });

  await processRefund(orderId, {}, { userId });

  // The refund must credit the VARIANT row (the line's variantId), and
  // must NOT touch the parent product's row.
  const parentStock = await db.stockLevel.findFirst({
    where: { productId, variantId: null },
  });
  assert.equal(parentStock!.quantity, 8); // untouched
  const variantStock = await db.stockLevel.findFirst({
    where: { variantId: variant.id },
  });
  assert.equal(variantStock!.quantity, 5); // 4 + 1 restored
});
