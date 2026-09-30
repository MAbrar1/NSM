/* ═══════════════════════════════════════════════════════════════
   RECEIPT ISSUE INTEGRATION TESTS (real SQLite via Prisma)
   Proves the receipt row is created INSIDE the sale transaction:
   - receipt exists with a frozen snapshot + content hash
   - numbering is gap-free and per-terminal (no collisions)
   - a failed checkout burns NO receipt number (atomicity)
   Run: npx tsx --test tests/receipt-issue-integration.test.ts
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
import { processCheckout, CheckoutError, type CheckoutInput } from "@/lib/checkout/checkout-service";
import { computeReceiptContentHash, RECEIPT_TEMPLATE_VERSION } from "@/lib/receipts/receipt-snapshot";

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

let userId = "";
let warehouseId = "";
let productId = "";

async function seedBase(stock = 100) {
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
      taxRate: 0,
    },
  });
  productId = product.id;
  await db.stockLevel.create({
    data: { productId, warehouseId, quantity: stock },
  });
}

function honestInput(qty: number, terminalId?: string): CheckoutInput {
  return {
    warehouseId,
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
        taxRate: 0,
        taxAmount: 0,
        total: 500 * qty,
      },
    ],
    subtotal: 500 * qty,
    taxAmount: 0,
    discountAmount: 0,
    total: 500 * qty,
    loyaltyPointsRedeemed: 0,
    paymentMethod: "cash",
    amountPaid: 500 * qty,
    changeDue: 0,
    ...(terminalId ? { terminalId } : {}),
  };
}

test("checkout issues a receipt with frozen snapshot and matching hash", async () => {
  await seedBase();
  const order = await processCheckout(honestInput(2), { userId });

  const receipt = await db.receipt.findUnique({ where: { orderId: order.id } });
  assert.ok(receipt, "receipt row exists");
  assert.equal(receipt.status, "ISSUED");
  assert.equal(receipt.templateVersion, RECEIPT_TEMPLATE_VERSION);

  const snapshot = JSON.parse(receipt.snapshotJson);
  assert.equal(snapshot.total, 1000);
  assert.equal(snapshot.cashierName, "Cashier");
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].productName, "Coffee");

  // Hash verifies against the stored snapshot — the reprint gate.
  assert.equal(
    computeReceiptContentHash(snapshot, receipt.templateVersion),
    receipt.contentHash
  );
});

test("receipt numbering is gap-free per terminal and collision-free across terminals", async () => {
  await seedBase();
  const o1 = await processCheckout(honestInput(1, "T1"), { userId });
  const o2 = await processCheckout(honestInput(1, "T1"), { userId });
  const o3 = await processCheckout(honestInput(1, "T2"), { userId });
  const o4 = await processCheckout(honestInput(1, "T1"), { userId });

  const receipts = await db.receipt.findMany();
  const byNo = new Map(receipts.map((r) => [r.receiptNo, r]));
  assert.equal(byNo.size, receipts.length, "no duplicate receipt numbers");

  assert.ok(byNo.has("R-T1-000001"), "T1 first");
  assert.ok(byNo.has("R-T1-000002"), "T1 second");
  assert.ok(byNo.has("R-T1-000003"), "T1 third (o4)");
  assert.ok(byNo.has("R-T2-000001"), "T2 independent series");

  const r1 = byNo.get("R-T1-000001")!;
  assert.equal(r1.orderId, o1.id);
  const r3 = await db.receipt.findUnique({ where: { orderId: o3.id } });
  assert.equal(r3!.terminalId, "T2");
});

test("a failed checkout burns no receipt number", async () => {
  await seedBase(6);
  await processCheckout(honestInput(1, "T1"), { userId });

  // 6 in stock: selling 1 leaves 5, so asking for 6 is a genuine oversell.
  await assert.rejects(
    () => processCheckout(honestInput(6, "T1"), { userId }),
    (err: unknown) => err instanceof CheckoutError && err.code === "insufficient_stock"
  );

  // The rolled-back sale must NOT have consumed R-T1-000002.
  const next = await processCheckout(honestInput(1, "T1"), { userId });
  const receipt = await db.receipt.findUnique({ where: { orderId: next.id } });
  assert.equal(receipt!.receiptNo, "R-T1-000002");
  assert.equal(await db.receipt.count({ where: { terminalId: "T1" } }), 2);
});
