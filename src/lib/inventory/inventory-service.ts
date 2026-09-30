/* ═══════════════════════════════════════════════════════════════
   INVENTORY SERVICE
   The single writer for StockLevel rows. Every stock change in the
   app — checkout, refund, order cancel, POS quick-restock, manual
   adjustment, warehouse transfer (both legs), PO receive, product
   create and CSV import — goes through here, so one rule owns:

     • the (productId, variantId, warehouseId) row lookup, with NULL
       for variant-less rows (a composite findUnique with "" never
       matches — the bug this lookup exists to prevent)
     • the atomic guarded decrement (WHERE quantity >= requested) so
       two concurrent removals can never both act on a stale read
     • the reservation release, clamped at zero and cleared of its
       reservedAt stamp when it empties
     • the reserve guard: available = quantity − reservedQuantity

   Callers keep their own transactions and their own user-facing
   error text; this module only owns the arithmetic and the writes.
   Pure of Next/React so the rules stay unit-testable.
   ═══════════════════════════════════════════════════════════════ */

import type { Prisma } from "@prisma/client";

/** The client surface these helpers need — a tx or the root db client. */
type Tx = Prisma.TransactionClient;

/** Which stock row a write targets. `variantId` NULL = the base product row. */
export interface StockKey {
  productId: string;
  warehouseId: string;
  variantId?: string | null;
}

/** A stock row's identity plus the numbers a caller decides with. */
export interface StockRowSnapshot {
  id: string;
  quantity: number;
  reservedQuantity: number;
}

/** Outcome of a stock write. `available` is filled in only on failure. */
export interface StockWriteResult {
  ok: boolean;
  /** On-hand quantity observed when the write was refused. */
  available: number;
}

/**
 * Find the stock row for a product/variant in one warehouse. The
 * variantId match is exact and treats missing as NULL, so a variant's
 * write can never land on the parent product's row.
 */
export async function findStockRow(tx: Tx, key: StockKey): Promise<StockRowSnapshot | null> {
  return tx.stockLevel.findFirst({
    where: {
      productId: key.productId,
      warehouseId: key.warehouseId,
      variantId: key.variantId ?? null,
    },
    select: { id: true, quantity: true, reservedQuantity: true },
  });
}

/**
 * Apply a signed delta to one stock row, atomically.
 *
 * A removal (negative delta) is guarded by `quantity >= -delta`, so the
 * row is re-checked under its write lock and two concurrent removals
 * cannot both apply their stale read and drive stock negative. An
 * addition is an unconditional increment.
 */
export async function applyStockDelta(
  tx: Tx,
  stockLevelId: string,
  delta: number
): Promise<StockWriteResult> {
  const updated = await tx.stockLevel.updateMany({
    where: {
      id: stockLevelId,
      ...(delta < 0 ? { quantity: { gte: -delta } } : {}),
    },
    data: { quantity: { increment: delta } },
  });

  if (updated.count > 0) return { ok: true, available: 0 };

  const current = await tx.stockLevel.findUnique({
    where: { id: stockLevelId },
    select: { quantity: true },
  });
  return { ok: false, available: current?.quantity ?? 0 };
}

/**
 * How `creditStock` treats a missing row:
 *   "credit"            → nothing exists to credit; no-op (returns null).
 *                         Used by refunds, cancels and returns, which must
 *                         never conjure an empty row for a product that
 *                         had no stock record in that warehouse.
 *   "credit-or-create"  → create the row holding the incoming quantity.
 *                         Used by restocks, PO receives and transfer-ins,
 *                         where the goods genuinely arrive.
 */
export type CreditMode = "credit" | "credit-or-create";

/**
 * Add stock to a row, incrementing atomically (never read-then-write,
 * which double-applies when two credits race on the same row).
 */
export async function creditStock(
  tx: Tx,
  key: StockKey,
  quantity: number,
  mode: CreditMode = "credit"
): Promise<{ id: string; created: boolean } | null> {
  const existing = await findStockRow(tx, key);

  if (existing) {
    await tx.stockLevel.update({
      where: { id: existing.id },
      data: { quantity: { increment: quantity } },
    });
    return { id: existing.id, created: false };
  }

  if (mode === "credit") return null;

  const created = await tx.stockLevel.create({
    data: {
      productId: key.productId,
      variantId: key.variantId || undefined,
      warehouseId: key.warehouseId,
      quantity,
      reservedQuantity: 0,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

/** Remove stock from a row, refusing when it would go negative. */
export async function debitStock(
  tx: Tx,
  key: StockKey,
  quantity: number
): Promise<StockWriteResult> {
  const row = await findStockRow(tx, key);
  if (!row) return { ok: false, available: 0 };
  return applyStockDelta(tx, row.id, -quantity);
}

/**
 * Guarantee the stock row exists, creating it empty when absent —
 * used when a product is born (single create + CSV import) so both
 * paths lay down the same initial row instead of two hand-written
 * creates that could drift.
 */
export async function ensureStockRow(
  tx: Tx,
  key: StockKey,
  quantity = 0
): Promise<{ id: string; created: boolean }> {
  const existing = await findStockRow(tx, key);
  if (existing) return { id: existing.id, created: false };

  const created = await tx.stockLevel.create({
    data: {
      productId: key.productId,
      variantId: key.variantId || undefined,
      warehouseId: key.warehouseId,
      quantity,
      reservedQuantity: 0,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

/**
 * Reserve available stock. Available = quantity − reservedQuantity, so
 * the guard re-checks that under the row's write lock and two
 * concurrent reservations can never oversell together. Stamps
 * reservedAt so the cleanup job can release only stale reservations.
 *
 * `currentReserved` is the value the caller just read — it is part of
 * the guard because the condition compares against a SQL-side column.
 */
export async function reserveStock(
  tx: Tx,
  stockLevelId: string,
  quantity: number,
  currentReserved: number,
  now: Date = new Date()
): Promise<boolean> {
  const updated = await tx.stockLevel.updateMany({
    where: { id: stockLevelId, quantity: { gte: currentReserved + quantity } },
    data: {
      reservedQuantity: { increment: quantity },
      reservedAt: now,
    },
  });
  return updated.count > 0;
}

/**
 * Release a reservation, never below zero. The write is conditional on
 * reservedQuantity still matching the value the caller read, so a
 * concurrent change makes it a no-op instead of resurrecting a stale
 * reservation. Clearing the last reservation also clears reservedAt.
 *
 * Returns the reserved quantity the row is left holding.
 */
export async function releaseReservation(
  tx: Tx,
  stockLevelId: string,
  quantity: number,
  currentReserved: number
): Promise<number> {
  const newReserved = Math.max(0, currentReserved - quantity);

  await tx.stockLevel.updateMany({
    where: { id: stockLevelId, reservedQuantity: currentReserved },
    data: {
      reservedQuantity: newReserved,
      ...(newReserved === 0 ? { reservedAt: null } : {}),
    },
  });

  return newReserved;
}

/**
 * Release a reservation that has gone STALE — the cleanup sweep's
 * case, where the whole reservation is dropped rather than a known
 * quantity. Conditional on the reservation still being untouched
 * since the scan; rows with a NULL reservedAt (legacy data predating
 * reservation tracking) never match the age filter, so they are
 * released by a second unconditional pass.
 *
 * Returns false when the row was released elsewhere meanwhile, so the
 * sweep can report only what it actually freed.
 */
export async function releaseStaleReservation(
  tx: Tx,
  stockLevelId: string,
  opts: { cutoff: Date }
): Promise<boolean> {
  const updated = await tx.stockLevel.updateMany({
    where: { id: stockLevelId, reservedAt: { lt: opts.cutoff } },
    data: { reservedQuantity: 0, reservedAt: null },
  });
  if (updated.count > 0) return true;

  const legacy = await tx.stockLevel.updateMany({
    where: { id: stockLevelId, reservedAt: null },
    data: { reservedQuantity: 0 },
  });
  return legacy.count > 0;
}

/**
 * Sell-time deduction: take the sold quantity off the shelf AND give
 * back the reserved portion of it, in one step. A missing row reports
 * available 0 (a tracked product with no stock row cannot be verified).
 */
export async function deductForSale(
  tx: Tx,
  key: StockKey,
  quantity: number
): Promise<{ ok: true; reservedReleased: number } | { ok: false; available: number }> {
  const row = await findStockRow(tx, key);
  if (!row) return { ok: false, available: 0 };

  const write = await applyStockDelta(tx, row.id, -quantity);
  if (!write.ok) return { ok: false, available: write.available };

  const reservedReleased = await releaseReservation(tx, row.id, quantity, row.reservedQuantity);
  return { ok: true, reservedReleased };
}
