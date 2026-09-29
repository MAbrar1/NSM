/* ═══════════════════════════════════════════════════════════════
   CUSTOMER BALANCE INTEGRATION TESTS (real SQLite via Prisma)
   Exercises lib/customer-balance — the module that became the single
   writer of the denormalized Customer columns (totalSpent,
   orderCount, loyaltyPoints, outstandingBalance) for checkout,
   refunds, khata settlements and order cancellation.

   These lock the rules the refactor had to preserve, including the
   two that are easiest to get subtly wrong:
     • the concurrent-redemption guard (a redemption the balance
       cannot cover must write NOTHING)
     • the first-full-refund-only reversal (a second refund must not
       uncount the order or claw back loyalty twice)

   Run: npx tsx --test tests/customer-balance-integration.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./integration/env"; // MUST come before anything that loads @/lib/db
import { setupTestDb, teardownTestDb, cleanTables, db } from "./integration/db";
import {
  applySaleToCustomer,
  applyRefundToCustomer,
  applySettlementToCustomer,
  releaseOrderCredit,
} from "@/lib/customer-balance";
import { openCreditOrderWhere } from "@/lib/report-math";

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

const rand = () => Math.random().toString(36).slice(2, 8);

async function makeCustomer(overrides: Record<string, number> = {}) {
  return db.customer.create({ data: { name: `Customer ${rand()}`, ...overrides } });
}

async function reload(id: string) {
  return db.customer.findUniqueOrThrow({ where: { id } });
}

/* ─── Sale ────────────────────────────────────────────────────── */

test("applySaleToCustomer counts the order, adds spend and carries the new credit", async () => {
  const c = await makeCustomer();

  await applySaleToCustomer(db, {
    customerId: c.id,
    orderTotal: 1100,
    dueAmount: 300,
    settleApplied: 0,
    loyaltyEarned: 11,
    loyaltyRedeemed: 0,
  });

  const after = await reload(c.id);
  assert.equal(after.orderCount, 1);
  assert.equal(after.totalSpent, 1100);
  assert.equal(after.loyaltyPoints, 11);
  assert.equal(after.outstandingBalance, 300);
});

test("applySaleToCustomer nets old dues collected at the register", async () => {
  const c = await makeCustomer({ outstandingBalance: 800 });

  // New shortfall 300, but 500 of older dues settled in the same checkout.
  await applySaleToCustomer(db, {
    customerId: c.id,
    orderTotal: 2000,
    dueAmount: 300,
    settleApplied: 500,
    loyaltyEarned: 20,
    loyaltyRedeemed: 0,
  });

  assert.equal((await reload(c.id)).outstandingBalance, 600); // 800 + 300 − 500
});

test("applySaleToCustomer leaves the balance untouched on a net-zero sale", async () => {
  const c = await makeCustomer({ outstandingBalance: 250 });

  await applySaleToCustomer(db, {
    customerId: c.id,
    orderTotal: 500,
    dueAmount: 0,
    settleApplied: 0,
    loyaltyEarned: 5,
    loyaltyRedeemed: 0,
  });

  const after = await reload(c.id);
  assert.equal(after.outstandingBalance, 250);
  assert.equal(after.totalSpent, 500); // the other counters still moved
  assert.equal(after.orderCount, 1);
});

test("applySaleToCustomer burns redeemed points against earned", async () => {
  const c = await makeCustomer({ loyaltyPoints: 100 });

  await applySaleToCustomer(db, {
    customerId: c.id,
    orderTotal: 1500,
    dueAmount: 0,
    settleApplied: 0,
    loyaltyEarned: 15,
    loyaltyRedeemed: 40,
  });

  assert.equal((await reload(c.id)).loyaltyPoints, 75); // 100 + 15 − 40
});

test("applySaleToCustomer writes NOTHING when the balance cannot cover the redemption", async () => {
  // The guarded updateMany: a concurrent redemption must not push the
  // balance negative, and must not half-apply the other counters either.
  const c = await makeCustomer({ loyaltyPoints: 10 });

  await applySaleToCustomer(db, {
    customerId: c.id,
    orderTotal: 5000,
    dueAmount: 5000,
    settleApplied: 0,
    loyaltyEarned: 50,
    loyaltyRedeemed: 999,
  });

  const after = await reload(c.id);
  assert.equal(after.loyaltyPoints, 10);
  assert.equal(after.totalSpent, 0);
  assert.equal(after.orderCount, 0);
  assert.equal(after.outstandingBalance, 0);
});

/* ─── Refund ──────────────────────────────────────────────────── */

test("applyRefundToCustomer reduces spend and writes off the returned goods' due", async () => {
  const c = await makeCustomer({
    totalSpent: 2000,
    orderCount: 1,
    loyaltyPoints: 20,
    outstandingBalance: 500,
  });

  await applyRefundToCustomer(db, {
    customerId: c.id,
    refundAmount: 600,
    dueWrittenOff: 400,
    fullyRefundedNow: false,
    wasAlreadyFullyRefunded: false,
    loyaltyEarned: 20,
    loyaltyRedeemed: 0,
  });

  const after = await reload(c.id);
  assert.equal(after.totalSpent, 1400);
  assert.equal(after.outstandingBalance, 100);
  // Partial refund: the customer keeps the order and the loyalty it earned.
  assert.equal(after.orderCount, 1);
  assert.equal(after.loyaltyPoints, 20);
});

test("applyRefundToCustomer reverses the order and loyalty on the FIRST full refund", async () => {
  const c = await makeCustomer({
    totalSpent: 2000,
    orderCount: 1,
    loyaltyPoints: 20,
    outstandingBalance: 0,
  });

  await applyRefundToCustomer(db, {
    customerId: c.id,
    refundAmount: 2000,
    dueWrittenOff: 0,
    fullyRefundedNow: true,
    wasAlreadyFullyRefunded: false,
    loyaltyEarned: 20,
    loyaltyRedeemed: 5,
  });

  const after = await reload(c.id);
  assert.equal(after.totalSpent, 0);
  assert.equal(after.orderCount, 0);
  assert.equal(after.loyaltyPoints, 5); // 20 + (5 redeemed returned − 20 earned clawed back)
});

test("applyRefundToCustomer does not uncount an already-refunded order twice", async () => {
  const c = await makeCustomer({ totalSpent: 0, orderCount: 0, loyaltyPoints: 5 });

  await applyRefundToCustomer(db, {
    customerId: c.id,
    refundAmount: 100,
    dueWrittenOff: 0,
    fullyRefundedNow: true,
    wasAlreadyFullyRefunded: true, // the order was already refunded
    loyaltyEarned: 20,
    loyaltyRedeemed: 5,
  });

  const after = await reload(c.id);
  assert.equal(after.orderCount, 0); // not −1
  assert.equal(after.loyaltyPoints, 5); // no second clawback
});

/* ─── Settlement ──────────────────────────────────────────────── */

test("applySettlementToCustomer applies a partial khata payment", async () => {
  const c = await makeCustomer({ outstandingBalance: 900 });

  const result = await applySettlementToCustomer(db, c.id, 400, c.outstandingBalance);

  assert.equal(result.id, c.id);
  assert.equal(result.outstandingBalance, 500);
  assert.equal((await reload(c.id)).outstandingBalance, 500);
});

test("applySettlementToCustomer clamps an overpayment advance at zero", async () => {
  const c = await makeCustomer({ outstandingBalance: 300 });

  const result = await applySettlementToCustomer(db, c.id, 500, c.outstandingBalance);

  assert.equal(result.outstandingBalance, 0); // never negative
});

/* ─── Cancellation ────────────────────────────────────────────── */

test("releaseOrderCredit sheds an open due and no-ops on nothing", async () => {
  const c = await makeCustomer({ outstandingBalance: 750 });

  await releaseOrderCredit(db, c.id, 250);
  assert.equal((await reload(c.id)).outstandingBalance, 500);

  await releaseOrderCredit(db, c.id, 0);
  assert.equal((await reload(c.id)).outstandingBalance, 500);

  await releaseOrderCredit(db, c.id, -100);
  assert.equal((await reload(c.id)).outstandingBalance, 500);
});

/* ─── The invariant the refactor must not break ───────────────── */

test("balance after a credit sale equals the open-credit orders it is derived from", async () => {
  // The ledger the rollup rebuilds from and the verifier asserts against:
  // one completed credit order that still owes money.
  const user = await db.user.create({
    data: { email: `u-${rand()}@test.local`, name: "Cashier", password: "x" },
  });
  const warehouse = await db.warehouse.create({
    data: { name: "Main", code: `MAIN-${rand()}`, isDefault: true },
  });
  const c = await makeCustomer();

  await db.order.create({
    data: {
      orderNumber: `POS-${rand()}`,
      customerId: c.id,
      userId: user.id,
      warehouseId: warehouse.id,
      status: "completed",
      subtotal: 1000,
      total: 1000,
      dueAmount: 400,
      paymentStatus: "partial",
    },
  });

  await applySaleToCustomer(db, {
    customerId: c.id,
    orderTotal: 1000,
    dueAmount: 400,
    settleApplied: 0,
    loyaltyEarned: 10,
    loyaltyRedeemed: 0,
  });

  const agg = await db.order.groupBy({
    by: ["customerId"],
    where: { customerId: c.id, ...openCreditOrderWhere() },
    _sum: { dueAmount: true },
  });
  const derived = agg[0]?._sum.dueAmount ?? 0;
  const stored = (await reload(c.id)).outstandingBalance;

  assert.equal(stored, derived);
  assert.equal(stored, 400);
});

test("settling an order exactly drives the stored balance to the derived one", async () => {
  const c = await makeCustomer({ outstandingBalance: 400 });

  await applySettlementToCustomer(db, c.id, 400, c.outstandingBalance);

  // No open credit orders exist, so the derived and stored balances agree at 0.
  const agg = await db.order.groupBy({
    by: ["customerId"],
    where: { customerId: c.id, ...openCreditOrderWhere() },
    _sum: { dueAmount: true },
  });
  assert.equal(agg[0]?._sum.dueAmount ?? 0, 0);
  assert.equal((await reload(c.id)).outstandingBalance, 0);
});
