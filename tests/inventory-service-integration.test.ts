/* ═══════════════════════════════════════════════════════════════
   INVENTORY SERVICE INTEGRATION TESTS (real SQLite via Prisma)
   Exercises lib/inventory-service against a throwaway SQLite
   database — the module that became the ONLY writer of StockLevel
   rows (checkout, refund, cancel, restock, adjust, transfer ×2,
   PO receive, product create/import, reservation cleanup).

   These lock the behaviours the refactor had to preserve:
   variant-vs-base row matching, the guarded decrement, the
   reservation arithmetic, and the credit/credit-or-create split.

   Run: npx tsx --test tests/inventory-service-integration.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./integration/env"; // MUST come before anything that loads @/lib/db
import { setupTestDb, teardownTestDb, cleanTables, db } from "./integration/db";
import {
  findStockRow,
  applyStockDelta,
  creditStock,
  debitStock,
  ensureStockRow,
  reserveStock,
  releaseReservation,
  releaseStaleReservation,
  deductForSale,
} from "@/lib/inventory-service";

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

/** Unique suffix so repeated runs never collide on unique columns. */
const rand = () => Math.random().toString(36).slice(2, 8);

let warehouseId = "";
let productId = "";
let variantId = "";

async function seed() {
  const wh = await db.warehouse.create({
    data: { name: "Main", code: `MAIN-${rand()}`, isDefault: true, isActive: true },
  });
  warehouseId = wh.id;

  const category = await db.category.create({ data: { name: "Cat", slug: `cat-${rand()}` } });
  const product = await db.product.create({
    data: {
      name: "Coffee",
      slug: `coffee-${rand()}`,
      sku: `SKU-${rand()}`,
      categoryId: category.id,
      unitPrice: 500,
      costPrice: 300,
    },
  });
  productId = product.id;

  const variant = await db.productVariant.create({
    data: {
      productId,
      name: "Large",
      sku: `SKU-V-${rand()}`,
      unitPrice: 600,
      costPrice: 350,
    },
  });
  variantId = variant.id;
}

async function otherWarehouse(name: string) {
  const wh = await db.warehouse.create({ data: { name, code: `${name}-${rand()}` } });
  return wh.id;
}

async function quantityOf(id: string): Promise<number> {
  return (await db.stockLevel.findUniqueOrThrow({ where: { id } })).quantity;
}

/* ─── Row lookup ──────────────────────────────────────────────── */

test("findStockRow matches a variant row exactly and the base row as NULL", async () => {
  await seed();
  const base = await db.stockLevel.create({
    data: { productId, warehouseId, variantId: null, quantity: 10, reservedQuantity: 0 },
  });
  const variant = await db.stockLevel.create({
    data: { productId, warehouseId, variantId, quantity: 4, reservedQuantity: 0 },
  });

  const foundBase = await findStockRow(db, { productId, warehouseId });
  const foundVariant = await findStockRow(db, { productId, warehouseId, variantId });

  assert.equal(foundBase!.id, base.id);
  assert.equal(foundVariant!.id, variant.id);
  // The bug this lookup exists to prevent: a variant write landing on the
  // parent product's row (or a composite findUnique with "" matching nothing).
  assert.notEqual(foundBase!.id, foundVariant!.id);
});

test("findStockRow returns null for an unknown variant", async () => {
  await seed();
  await db.stockLevel.create({ data: { productId, warehouseId, quantity: 5, reservedQuantity: 0 } });
  assert.equal(await findStockRow(db, { productId, warehouseId, variantId: "nope" }), null);
});

/* ─── Guarded decrement ───────────────────────────────────────── */

test("applyStockDelta adds, removes within stock, and refuses to cross zero", async () => {
  await seed();
  const row = await db.stockLevel.create({
    data: { productId, warehouseId, quantity: 10, reservedQuantity: 0 },
  });

  assert.equal((await applyStockDelta(db, row.id, 5)).ok, true);
  assert.equal(await quantityOf(row.id), 15);

  assert.equal((await applyStockDelta(db, row.id, -10)).ok, true);
  assert.equal(await quantityOf(row.id), 5);

  const refused = await applyStockDelta(db, row.id, -6);
  assert.equal(refused.ok, false);
  assert.equal(refused.available, 5);
  assert.equal(await quantityOf(row.id), 5); // untouched
});

test("debitStock reports available 0 when the warehouse has no row", async () => {
  await seed();
  assert.deepEqual(await debitStock(db, { productId, warehouseId }, 1), {
    ok: false,
    available: 0,
  });

  await db.stockLevel.create({ data: { productId, warehouseId, quantity: 3, reservedQuantity: 0 } });
  assert.equal((await debitStock(db, { productId, warehouseId }, 3)).ok, true);
  assert.equal((await debitStock(db, { productId, warehouseId }, 1)).ok, false);
});

/* ─── Credit modes ────────────────────────────────────────────── */

test("creditStock 'credit' never creates a missing row", async () => {
  await seed();
  // A refund against a warehouse that never tracked the product must not
  // conjure an empty stock row.
  assert.equal(await creditStock(db, { productId, warehouseId }, 5), null);
  assert.equal(await db.stockLevel.count(), 0);
});

test("creditStock 'credit-or-create' creates the row holding the arrivals", async () => {
  await seed();
  const created = await creditStock(db, { productId, warehouseId }, 5, "credit-or-create");
  assert.equal(created!.created, true);
  assert.equal(await quantityOf(created!.id), 5);

  const again = await creditStock(db, { productId, warehouseId }, 2, "credit-or-create");
  assert.equal(again!.created, false);
  assert.equal(again!.id, created!.id);
  assert.equal(await quantityOf(created!.id), 7);
});

test("ensureStockRow is idempotent", async () => {
  await seed();
  const first = await ensureStockRow(db, { productId, warehouseId });
  assert.equal(first.created, true);

  const second = await ensureStockRow(db, { productId, warehouseId });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(await db.stockLevel.count(), 1);
  assert.equal(await quantityOf(first.id), 0);
});

/* ─── Reservations ────────────────────────────────────────────── */

test("reserveStock guards on available = quantity − reservedQuantity", async () => {
  await seed();
  const row = await db.stockLevel.create({
    data: { productId, warehouseId, quantity: 10, reservedQuantity: 0 },
  });

  assert.equal(await reserveStock(db, row.id, 4, row.reservedQuantity), true);
  let after = await db.stockLevel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.reservedQuantity, 4);
  assert.ok(after.reservedAt instanceof Date, "stamps reservedAt for the stale sweep");

  // Available is now 6, so a 7-unit reservation must be refused outright.
  assert.equal(await reserveStock(db, row.id, 7, after.reservedQuantity), false);
  after = await db.stockLevel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.reservedQuantity, 4);
});

test("releaseReservation clamps at zero and clears reservedAt when emptied", async () => {
  await seed();
  const row = await db.stockLevel.create({
    data: { productId, warehouseId, quantity: 10, reservedQuantity: 5, reservedAt: new Date() },
  });

  assert.equal(await releaseReservation(db, row.id, 2, 5), 3);
  assert.equal(
    (await db.stockLevel.findUniqueOrThrow({ where: { id: row.id } })).reservedQuantity,
    3
  );

  assert.equal(await releaseReservation(db, row.id, 10, 3), 0); // clamped, not negative
  const emptied = await db.stockLevel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(emptied.reservedQuantity, 0);
  assert.equal(emptied.reservedAt, null);
});

test("releaseReservation is a no-op when the reservation moved since the read", async () => {
  await seed();
  const row = await db.stockLevel.create({
    data: { productId, warehouseId, quantity: 10, reservedQuantity: 5, reservedAt: new Date() },
  });
  // A concurrent reservation raised it to 8 after our caller read 5.
  await db.stockLevel.update({ where: { id: row.id }, data: { reservedQuantity: 8 } });

  await releaseReservation(db, row.id, 2, 5);

  assert.equal(
    (await db.stockLevel.findUniqueOrThrow({ where: { id: row.id } })).reservedQuantity,
    8
  );
});

test("releaseStaleReservation frees stale and legacy rows, spares fresh ones", async () => {
  await seed();
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const backId = await otherWarehouse("Back");
  const legacyWhId = await otherWarehouse("Legacy");

  const stale = await db.stockLevel.create({
    data: {
      productId,
      warehouseId,
      quantity: 5,
      reservedQuantity: 3,
      reservedAt: new Date(Date.now() - 30 * 60 * 1000),
    },
  });
  const fresh = await db.stockLevel.create({
    data: { productId, warehouseId: backId, quantity: 5, reservedQuantity: 2, reservedAt: new Date() },
  });
  const legacy = await db.stockLevel.create({
    data: { productId, warehouseId: legacyWhId, quantity: 5, reservedQuantity: 2, reservedAt: null },
  });

  assert.equal(await releaseStaleReservation(db, stale.id, { cutoff }), true);
  const staleAfter = await db.stockLevel.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(staleAfter.reservedQuantity, 0);
  assert.equal(staleAfter.reservedAt, null);

  assert.equal(await releaseStaleReservation(db, fresh.id, { cutoff }), false);
  assert.equal(
    (await db.stockLevel.findUniqueOrThrow({ where: { id: fresh.id } })).reservedQuantity,
    2
  );

  // Legacy rows carry a NULL reservedAt and can never match the age filter.
  assert.equal(await releaseStaleReservation(db, legacy.id, { cutoff }), true);
  assert.equal(
    (await db.stockLevel.findUniqueOrThrow({ where: { id: legacy.id } })).reservedQuantity,
    0
  );
});

/* ─── Sell-time deduction ─────────────────────────────────────── */

test("deductForSale takes stock off the shelf and releases the reserved portion", async () => {
  await seed();
  const row = await db.stockLevel.create({
    data: { productId, warehouseId, quantity: 10, reservedQuantity: 4, reservedAt: new Date() },
  });

  const sale = await deductForSale(db, { productId, warehouseId }, 3);
  assert.deepEqual(sale, { ok: true, reservedReleased: 1 });

  const after = await db.stockLevel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.quantity, 7);
  assert.equal(after.reservedQuantity, 1);
});

test("deductForSale releases the whole reservation when the sale consumes it", async () => {
  await seed();
  const row = await db.stockLevel.create({
    data: { productId, warehouseId, quantity: 4, reservedQuantity: 2, reservedAt: new Date() },
  });

  const sale = await deductForSale(db, { productId, warehouseId }, 2);
  assert.deepEqual(sale, { ok: true, reservedReleased: 0 });

  const after = await db.stockLevel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.quantity, 2);
  assert.equal(after.reservedQuantity, 0);
  assert.equal(after.reservedAt, null);
});

test("deductForSale refuses an oversell and reports the row's real quantity", async () => {
  await seed();
  await db.stockLevel.create({ data: { productId, warehouseId, quantity: 2, reservedQuantity: 0 } });

  const sale = await deductForSale(db, { productId, warehouseId }, 5);
  assert.deepEqual(sale, { ok: false, available: 2 });
});

test("deductForSale reports available 0 for a tracked product with no row", async () => {
  await seed();
  assert.deepEqual(await deductForSale(db, { productId, warehouseId }, 1), {
    ok: false,
    available: 0,
  });
});

test("deductForSale only touches the row of the variant it was asked for", async () => {
  await seed();
  const base = await db.stockLevel.create({
    data: { productId, warehouseId, variantId: null, quantity: 10, reservedQuantity: 0 },
  });
  const variant = await db.stockLevel.create({
    data: { productId, warehouseId, variantId, quantity: 5, reservedQuantity: 0 },
  });

  await deductForSale(db, { productId, warehouseId, variantId }, 2);

  assert.equal(await quantityOf(variant.id), 3);
  assert.equal(await quantityOf(base.id), 10); // parent product untouched
});
