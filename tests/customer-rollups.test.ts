/* ═══════════════════════════════════════════════════════════════
   CUSTOMER ROLLUPS — integration tests (real SQLite via Prisma)

   Locks the repair rule used by the seeder and `npm run repair:rollups`:
   every customer's denormalized stats are rebuilt from the ORDER LEDGER,
   counting only the revenue statuses (completed / confirmed) and only
   positive khata dues.

   This is the fix for the drift that made the Customers page and the POS
   balance banner disagree with the Orders ledger: the customers existed
   and the orders existed, but totalSpent / orderCount / loyaltyPoints /
   outstandingBalance were stuck at 0. The second run of the repair must
   be a no-op (idempotent), or re-running it would mask real bugs.

   Run: npx tsx --test tests/customer-rollups.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./integration/env"; // MUST come before anything that loads @/lib/db
import { setupTestDb, teardownTestDb, cleanTables, db } from "./integration/db";
import { recomputeCustomerRollups, ROLLUP_PAID_STATUSES } from "@/lib/customer-rollups";

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
let seq = 0;

async function seedBase() {
  const user = await db.user.create({
    data: { email: "admin@test.local", name: "Admin", password: "x", role: "admin" },
  });
  userId = user.id;
  const wh = await db.warehouse.create({
    data: { name: "Main", code: "MAIN", isDefault: true, isActive: true },
  });
  warehouseId = wh.id;
}

/** One ledger row. `total`/`dueAmount` are cents; userId + warehouse FKs filled in. */
async function order(opts: {
  customerId: string | null;
  status: string;
  total: number;
  dueAmount?: number;
}) {
  seq += 1;
  const due = opts.dueAmount ?? 0;
  return db.order.create({
    data: {
      orderNumber: `T-${seq}`,
      customerId: opts.customerId,
      userId,
      warehouseId,
      status: opts.status,
      type: "sale",
      subtotal: opts.total,
      total: opts.total,
      paidAmount: opts.total - due,
      dueAmount: due,
      paymentStatus: due > 0 ? "partial" : "paid",
    },
  });
}

test("revenue statuses are completed + confirmed only (no drift from the verifier)", () => {
  assert.deepEqual([...ROLLUP_PAID_STATUSES], ["completed", "confirmed"]);
});

test("totalSpent / orderCount / loyalty rebuild from PAID orders only", async () => {
  await seedBase();
  const c = await db.customer.create({ data: { name: "Drifted", totalSpent: 0, orderCount: 0, loyaltyPoints: 0 } });

  await order({ customerId: c.id, status: "completed", total: 10_000 });
  await order({ customerId: c.id, status: "confirmed", total: 5_000 });
  // Excluded: not revenue.
  await order({ customerId: c.id, status: "pending", total: 7_000 });
  await order({ customerId: c.id, status: "cancelled", total: 3_000 });
  await order({ customerId: c.id, status: "refunded", total: 4_000 });

  const result = await recomputeCustomerRollups(db);
  assert.equal(result.changed, 1);

  const after = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.totalSpent, 15_000);
  assert.equal(after.orderCount, 2);
  // floor(15000 / 100) — 1 point per whole dollar (lib/earn-rate).
  assert.equal(after.loyaltyPoints, 150);
  assert.equal(after.outstandingBalance, 0);
});

test("outstandingBalance counts only positive dues on PAID orders", async () => {
  await seedBase();
  const c = await db.customer.create({ data: { name: "Khata" } });

  await order({ customerId: c.id, status: "completed", total: 5_000, dueAmount: 2_500 });
  await order({ customerId: c.id, status: "confirmed", total: 2_000, dueAmount: 500 });
  await order({ customerId: c.id, status: "completed", total: 1_000, dueAmount: 0 }); // settled
  await order({ customerId: c.id, status: "pending", total: 3_000, dueAmount: 900 }); // not revenue
  await order({ customerId: c.id, status: "refunded", total: 4_000, dueAmount: 800 }); // not revenue

  await recomputeCustomerRollups(db);

  const after = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.outstandingBalance, 3_000);
  // All three PAID orders count toward spend; only the two with a due add to khata.
  assert.equal(after.totalSpent, 8_000);
  assert.equal(after.orderCount, 3);
});

test("walk-in orders (no customer) never touch any row", async () => {
  await seedBase();
  const c = await db.customer.create({ data: { name: "Real" } });
  await order({ customerId: null, status: "completed", total: 99_999 });
  await order({ customerId: c.id, status: "completed", total: 1_000 });

  const result = await recomputeCustomerRollups(db);
  assert.equal(result.changed, 1);
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).totalSpent, 1_000);
});

test("a customer whose orders vanished is zeroed, not left stale", async () => {
  await seedBase();
  const c = await db.customer.create({
    data: { name: "Stale", totalSpent: 999, orderCount: 3, loyaltyPoints: 9, outstandingBalance: 5 },
  });

  const result = await recomputeCustomerRollups(db);
  assert.equal(result.changed, 1);

  const after = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual(
    {
      totalSpent: after.totalSpent,
      orderCount: after.orderCount,
      loyaltyPoints: after.loyaltyPoints,
      outstandingBalance: after.outstandingBalance,
    },
    { totalSpent: 0, orderCount: 0, loyaltyPoints: 0, outstandingBalance: 0 }
  );
});

test("idempotent: the second run reports nothing to repair", async () => {
  await seedBase();
  const a = await db.customer.create({ data: { name: "A" } });
  const b = await db.customer.create({ data: { name: "B", totalSpent: 42 } });
  await order({ customerId: a.id, status: "completed", total: 20_000, dueAmount: 1_234 });
  await order({ customerId: b.id, status: "confirmed", total: 3_000 });

  const first = await recomputeCustomerRollups(db);
  assert.equal(first.checked, 2);
  assert.equal(first.changed, 2);
  assert.equal(first.withDues, 1);

  const second = await recomputeCustomerRollups(db);
  assert.equal(second.checked, 2);
  assert.equal(second.changed, 0);
  assert.equal(second.updates.length, 0);
});
