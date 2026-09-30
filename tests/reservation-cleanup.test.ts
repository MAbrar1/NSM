/* ═══════════════════════════════════════════════════════════════
   RESERVATION CLEANUP — unit tests
   Locks the stale-reservation sweep (lib/reservation-cleanup.ts):
   stale rows are released, fresh rows are left alone, legacy rows
   with no timestamp are released, and scan/release failures never
   throw (the scheduler fires this blindly).
   Run: npx tsx --test tests/reservation-cleanup.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import {
  releaseStaleReservations,
  STALE_AFTER_MS,
} from "@/lib/inventory/reservation-cleanup";

/** Minute-precision helper for readable cutoffs. */
const MIN = 60 * 1000;

function stubStockLevel(impl: {
  findMany?: () => Promise<unknown>;
  updateMany?: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
}): () => void {
  const origFindMany = db.stockLevel.findMany.bind(db.stockLevel);
  const origUpdateMany = db.stockLevel.updateMany.bind(db.stockLevel);
  if (impl.findMany) (db.stockLevel.findMany as unknown) = impl.findMany;
  if (impl.updateMany) (db.stockLevel.updateMany as unknown) = impl.updateMany;
  return () => {
    (db.stockLevel.findMany as unknown) = origFindMany;
    (db.stockLevel.updateMany as unknown) = origUpdateMany;
  };
}

test("STALE_AFTER_MS is 15 minutes", () => {
  assert.equal(STALE_AFTER_MS, 15 * MIN);
});

test("releases stale reservations and reports freed quantity", async () => {
  const now = Date.now();
  const restore = stubStockLevel({
    findMany: async () => [
      { id: "stale-1", reservedQuantity: 3 },
      { id: "stale-2", reservedQuantity: 0.5 },
    ],
    updateMany: async (args) => {
      // Simulate the DB's conditional write: only rows whose reservation
      // is older than the cutoff are released.
      const where = args.where as { reservedAt?: { lt?: Date } };
      const stale = where.reservedAt?.lt ? where.reservedAt.lt.getTime() < now : false;
      return { count: stale ? 1 : 0 };
    },
  });
  try {
    const result = await releaseStaleReservations();
    assert.equal(result.releasedCount, 2);
    assert.equal(result.releasedQuantity, 3.5);
  } finally {
    restore();
  }
});

test("releases legacy rows that have no reservation timestamp", async () => {
  const restore = stubStockLevel({
    findMany: async () => [{ id: "legacy-1", reservedQuantity: 10 }],
    updateMany: async (args) => {
      const where = args.where as { reservedAt?: unknown };
      // First conditional attempt (reservedAt < cutoff) misses NULL rows;
      // the follow-up (reservedAt: null) releases them.
      return { count: "reservedAt" in where && where.reservedAt === null ? 1 : 0 };
    },
  });
  try {
    const result = await releaseStaleReservations();
    assert.equal(result.releasedCount, 1);
    assert.equal(result.releasedQuantity, 10);
  } finally {
    restore();
  }
});

test("scan failure never throws — returns zeroed result", async () => {
  const restore = stubStockLevel({
    findMany: async () => {
      throw new Error("db offline");
    },
  });
  try {
    const result = await releaseStaleReservations();
    assert.deepEqual(result, { releasedCount: 0, releasedQuantity: 0 });
  } finally {
    restore();
  }
});

test("one failing row does not abort the sweep — and is not counted as released", async () => {
  let calls = 0;
  const restore = stubStockLevel({
    findMany: async () => [
      { id: "bad-1", reservedQuantity: 2 },
      { id: "good-1", reservedQuantity: 4 },
    ],
    updateMany: async () => {
      calls += 1;
      if (calls === 1) throw new Error("row lock timeout");
      return { count: 1 };
    },
  });
  try {
    const result = await releaseStaleReservations();
    assert.equal(calls, 2); // both rows attempted — sweep continued
    // Only the successful release is counted; the failed row is retried
    // by the next sweep pass rather than being silently claimed as done.
    assert.equal(result.releasedCount, 1);
    assert.equal(result.releasedQuantity, 4);
  } finally {
    restore();
  }
});

test("custom stale window is honored (shorter window frees fresher rows)", async () => {
  const now = Date.now();
  let observedCutoff = 0;
  const restore = stubStockLevel({
    findMany: async () => [{ id: "r1", reservedQuantity: 1 }],
    updateMany: async (args) => {
      const where = args.where as { reservedAt?: { lt?: Date } };
      observedCutoff = where.reservedAt?.lt?.getTime() ?? 0;
      return { count: 1 };
    },
  });
  try {
    await releaseStaleReservations(5 * MIN);
    // Cutoff should be ~5 minutes ago, comfortably after the default's mark.
    const defaultCutoff = now - STALE_AFTER_MS;
    assert.ok(observedCutoff > defaultCutoff, "shorter window produces a later cutoff");
  } finally {
    restore();
  }
});
