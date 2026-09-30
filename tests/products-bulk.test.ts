/* ═══════════════════════════════════════════════════════════════
   PRODUCTS BULK SERVICE — integration tests (real SQLite via Prisma)
   Exercises lib/products-bulk (the engine behind PUT /api/products/
   bulk) against a throwaway database: payload validation, partial
   success, not-found paths, the audit trail, and the RBAC gate the
   route applies on top.

   Run: npx tsx --test tests/products-bulk.test.ts
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
import {
  bulkUpdateProducts,
  validateBulkUpdateInput,
  BulkUpdateError,
} from "@/lib/products-bulk";
import { hasPermission } from "@/lib/auth/rbac";

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
let categoryId = "";
let otherCategoryId = "";
let productIds: string[] = [];

async function seedProducts(n: number, opts?: { status?: "active" | "inactive" | "discontinued" }) {
  const user = await db.user.create({
    data: { email: "manager@test.local", name: "Manager", password: "x", role: "manager" },
  });
  userId = user.id;
  const cat = await db.category.create({
    data: { name: "Cat A", slug: "cat-a-" + Math.random().toString(36).slice(2, 8) },
  });
  categoryId = cat.id;
  const cat2 = await db.category.create({
    data: { name: "Cat B", slug: "cat-b-" + Math.random().toString(36).slice(2, 8) },
  });
  otherCategoryId = cat2.id;

  productIds = [];
  for (let i = 0; i < n; i++) {
    const p = await db.product.create({
      data: {
        name: `Product ${i}`,
        slug: `product-${i}-` + Math.random().toString(36).slice(2, 8),
        sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
        categoryId: cat.id,
        unitPrice: 500,
        costPrice: 300,
        status: opts?.status ?? "active",
      },
    });
    productIds.push(p.id);
  }
}

/* ─── Payload validation (no database touched) ────────────────── */

test("validate rejects an empty selection", () => {
  assert.throws(() => validateBulkUpdateInput({ ids: [] }), BulkUpdateError);
});

test("validate rejects a missing or non-array ids field", () => {
  assert.throws(() => validateBulkUpdateInput({}), BulkUpdateError);
  assert.throws(() => validateBulkUpdateInput({ ids: "nope" }), BulkUpdateError);
});

test("validate rejects non-string ids inside the array", () => {
  assert.throws(() => validateBulkUpdateInput({ ids: [42] }), BulkUpdateError);
  assert.throws(() => validateBulkUpdateInput({ ids: [null] }), BulkUpdateError);
});

test("validate rejects selections over the 200 cap", () => {
  const ids = Array.from({ length: 201 }, (_, i) => String(i));
  assert.throws(() => validateBulkUpdateInput({ ids, status: "active" }), BulkUpdateError);
});

test("validate rejects an invalid status value", () => {
  assert.throws(
    () => validateBulkUpdateInput({ ids: ["x"], status: "archived" }),
    BulkUpdateError
  );
});

test("validate rejects an empty categoryId string", () => {
  assert.throws(
    () => validateBulkUpdateInput({ ids: ["x"], categoryId: "" }),
    BulkUpdateError
  );
});

test("validate rejects a payload with nothing to update", () => {
  assert.throws(() => validateBulkUpdateInput({ ids: ["x"] }), BulkUpdateError);
});

test("validate accepts a valid status payload", () => {
  const parsed = validateBulkUpdateInput({ ids: ["a", "b"], status: "inactive" });
  assert.deepEqual(parsed, {
    ids: ["a", "b"], status: "inactive",
    categoryId: undefined, brandId: undefined, priceAdjust: undefined,
  });
});

test("validate accepts a combined status + category payload", () => {
  const parsed = validateBulkUpdateInput({
    ids: ["a"],
    status: "active",
    categoryId: "cat-1",
  });
  assert.equal(parsed.status, "active");
  assert.equal(parsed.categoryId, "cat-1");
});

/* ─── Service behaviour against the real database ─────────────── */

test("bulk status update changes every selected product", async () => {
  await seedProducts(3);
  const result = await bulkUpdateProducts({ ids: productIds, status: "discontinued" }, userId);
  assert.equal(result.updated, 3);
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) assert.equal(row.status, "discontinued");
});

test("bulk category move reassigns every selected product", async () => {
  await seedProducts(2);
  const result = await bulkUpdateProducts({ ids: productIds, categoryId: otherCategoryId }, userId);
  assert.equal(result.updated, 2);
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) assert.equal(row.categoryId, otherCategoryId);
});

test("combined status + category applies both fields", async () => {
  await seedProducts(2);
  await bulkUpdateProducts(
    { ids: productIds, status: "inactive", categoryId: otherCategoryId },
    userId
  );
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) {
    assert.equal(row.status, "inactive");
    assert.equal(row.categoryId, otherCategoryId);
  }
});

test("bulk brand assignment rebrands every selected product", async () => {
  await seedProducts(2);
  const brand = await db.brand.create({
    data: { name: "Acme", slug: "acme-" + Math.random().toString(36).slice(2, 8) },
  });
  const result = await bulkUpdateProducts({ ids: productIds, brandId: brand.id }, userId);
  assert.equal(result.updated, 2);
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) assert.equal(row.brandId, brand.id);
});

test("bulk brand clear removes the brand from every selected product", async () => {
  await seedProducts(2);
  const brand = await db.brand.create({
    data: { name: "Acme", slug: "acme-" + Math.random().toString(36).slice(2, 8) },
  });
  await db.product.updateMany({ where: { id: { in: productIds } }, data: { brandId: brand.id } });
  await bulkUpdateProducts({ ids: productIds, brandId: "" }, userId);
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) assert.equal(row.brandId, null);
});

test("nonexistent brand is rejected with 404 semantics", async () => {
  await seedProducts(1);
  await assert.rejects(
    () => bulkUpdateProducts({ ids: productIds, brandId: "ghost-brand" }, userId),
    (err: unknown) => err instanceof BulkUpdateError && err.status === 404
  );
});

test("percent price scaling multiplies every selected product's price", async () => {
  await seedProducts(2);
  await bulkUpdateProducts(
    { ids: productIds, priceAdjust: { mode: "percent", value: 10, applyTo: "unitPrice" } },
    userId
  );
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) assert.equal(row.unitPrice, 550); // 500 + 10%
});

test("amount price adjustment adds major units to the price", async () => {
  await seedProducts(2);
  await bulkUpdateProducts(
    { ids: productIds, priceAdjust: { mode: "amount", value: 1.25, applyTo: "unitPrice" } },
    userId
  );
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) assert.equal(row.unitPrice, 625); // 500 + 125c
});

test("price adjustment on 'both' scales selling and cost price together", async () => {
  await seedProducts(1);
  await bulkUpdateProducts(
    { ids: productIds, priceAdjust: { mode: "percent", value: -20, applyTo: "both" } },
    userId
  );
  const row = await db.product.findUnique({ where: { id: productIds[0]! } });
  assert.equal(row?.unitPrice, 400); // 500 − 20%
  assert.equal(row?.costPrice, 240); // 300 − 20%
});

test("price adjustment never drives a price below zero", async () => {
  await seedProducts(1);
  await bulkUpdateProducts(
    { ids: productIds, priceAdjust: { mode: "amount", value: -1000, applyTo: "unitPrice" } },
    userId
  );
  const row = await db.product.findUnique({ where: { id: productIds[0]! } });
  assert.equal(row?.unitPrice, 0);
});

test("validate rejects a malformed price adjustment", () => {
  assert.throws(
    () => validateBulkUpdateInput({ ids: ["x"], priceAdjust: { mode: "percent", value: 10 } }),
    BulkUpdateError
  );
  assert.throws(
    () => validateBulkUpdateInput({ ids: ["x"], priceAdjust: { mode: "percent", value: 5000, applyTo: "unitPrice" } }),
    BulkUpdateError
  );
  assert.throws(
    () => validateBulkUpdateInput({ ids: ["x"], priceAdjust: { mode: "square", value: 10, applyTo: "unitPrice" } }),
    BulkUpdateError
  );
});

/* ─── Original status/category coverage ───────────────────────── */

test("partial success: unknown ids are skipped, known ids updated", async () => {
  await seedProducts(2);
  const result = await bulkUpdateProducts(
    { ids: [productIds[0]!, "nonexistent-id", productIds[1]!], status: "inactive" },
    userId
  );
  assert.equal(result.updated, 2);
});

test("selection matching nothing is rejected with 404 semantics", async () => {
  await seedProducts(1);
  await assert.rejects(
    () => bulkUpdateProducts({ ids: ["ghost-1", "ghost-2"], status: "active" }, userId),
    (err: unknown) => err instanceof BulkUpdateError && err.status === 404
  );
});

test("nonexistent category is rejected with 404 semantics", async () => {
  await seedProducts(1);
  await assert.rejects(
    () => bulkUpdateProducts({ ids: productIds, categoryId: "ghost-cat" }, userId),
    (err: unknown) => err instanceof BulkUpdateError && err.status === 404
  );
});

test("service refuses to run with neither status nor categoryId", async () => {
  await seedProducts(1);
  await assert.rejects(
    () => bulkUpdateProducts({ ids: productIds }, userId),
    BulkUpdateError
  );
  // Database untouched — products keep their original status.
  const rows = await db.product.findMany({ where: { id: { in: productIds } } });
  for (const row of rows) assert.equal(row.status, "active");
});

test("unselected products are left untouched", async () => {
  await seedProducts(4);
  const onlyFirstTwo = productIds.slice(0, 2);
  await bulkUpdateProducts({ ids: onlyFirstTwo, status: "inactive" }, userId);
  const untouched = await db.product.findUnique({ where: { id: productIds[2]! } });
  assert.equal(untouched?.status, "active");
});

test("every accepted bulk update writes an audit entry with the count", async () => {
  await seedProducts(3);
  await bulkUpdateProducts({ ids: productIds, status: "inactive" }, userId);
  const entry = await db.auditLog.findFirst({
    where: { userId, entity: "product", action: "update" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(entry, "expected an audit log row");
  assert.ok(entry.entityName && entry.entityName.includes("3 products (bulk)"), String(entry.entityName));
  const newValues = JSON.parse(entry.newValues ?? "{}") as { count?: number };
  assert.equal(newValues.count, 3);
});

test("failed updates never write an audit entry", async () => {
  await seedProducts(1);
  const before = await db.auditLog.count({ where: { userId } });
  await assert.rejects(
    () => bulkUpdateProducts({ ids: ["ghost"], status: "active" }, userId),
    BulkUpdateError
  );
  const after = await db.auditLog.count({ where: { userId } });
  assert.equal(after, before);
});

/* ─── RBAC gate the route applies on top of the service ───────── */

test("manager passes the products:edit gate", () => {
  assert.equal(hasPermission("manager", "products:edit"), true);
});

test("cashier is refused by the products:edit gate", () => {
  assert.equal(hasPermission("cashier", "products:edit"), false);
});

test("viewer is refused by the products:edit gate", () => {
  assert.equal(hasPermission("viewer", "products:edit"), false);
});

test("admin passes the products:edit gate", () => {
  assert.equal(hasPermission("admin", "products:edit"), true);
});
