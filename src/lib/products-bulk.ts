import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit-log";
import { majorToCents } from "@/lib/money/money";

/* ═══════════════════════════════════════════════════════════════
   PRODUCTS BULK SERVICE
   Applies one operation to a set of products. Extracted from the
   API route so it can be exercised directly against a real database
   in tests — the same pattern as lib/checkout-service.

   Supported operations (any combination in one call):
     • status       → active | inactive | discontinued
     • categoryId   → move products to another category
     • brandId      → assign a brand ("" clears it)
     • priceAdjust  → scale/shift prices across the selection:
                        percent: value -99..1000 (e.g. 10 = +10%)
                        amount:  major units added/subtracted
                      applied to unitPrice, costPrice, or both.
                      Results are clamped at ≥ 0 cents per product.

   Semantics:
     • Unknown product ids are skipped (partial success), but a
       selection matching NOTHING is rejected.
     • "Nothing to update" payloads are rejected — almost always a
       caller bug.
     • Every accepted call writes one audit entry with the count.
   ═══════════════════════════════════════════════════════════════ */

export interface PriceAdjust {
  mode: "percent" | "amount";
  /** percent: -99..1000; amount: major units, -1e6..1e6 */
  value: number;
  applyTo: "unitPrice" | "costPrice" | "both";
}

export interface BulkUpdateInput {
  ids: string[];
  status?: "active" | "inactive" | "discontinued";
  categoryId?: string;
  /** Assign a brand; empty string clears the brand. */
  brandId?: string;
  /** Scale or shift prices across the selection. */
  priceAdjust?: PriceAdjust;
}

export interface BulkUpdateResult {
  updated: number;
}

export class BulkUpdateError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BulkUpdateError";
    this.status = status;
  }
}

/** Shape validation split out from Prisma logic so bad payloads are
    rejected without touching the database. */
export function validateBulkUpdateInput(body: unknown): BulkUpdateInput {
  if (typeof body !== "object" || body === null) {
    throw new BulkUpdateError("Invalid request body");
  }
  const { ids, status, categoryId, brandId, priceAdjust: priceAdjustRaw } =
    body as Record<string, unknown>;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new BulkUpdateError("Select at least one product");
  }
  if (ids.length > 200) {
    throw new BulkUpdateError("Cannot update more than 200 products at once");
  }
  if (!ids.every((id) => typeof id === "string" && id.length > 0)) {
    throw new BulkUpdateError("Invalid product id in selection");
  }
  if (
    status !== undefined &&
    status !== "active" &&
    status !== "inactive" &&
    status !== "discontinued"
  ) {
    throw new BulkUpdateError("Invalid status value");
  }
  if (categoryId !== undefined && (typeof categoryId !== "string" || categoryId.length === 0)) {
    throw new BulkUpdateError("Invalid category id");
  }
  // brandId: undefined = not provided, "" = clear the brand.
  if (brandId !== undefined && typeof brandId !== "string") {
    throw new BulkUpdateError("Invalid brand id");
  }
  let priceAdjust: PriceAdjust | undefined;
  if (priceAdjustRaw !== undefined) {
    if (typeof priceAdjustRaw !== "object" || priceAdjustRaw === null) {
      throw new BulkUpdateError("Invalid price adjustment");
    }
    const { mode, value, applyTo } = priceAdjustRaw as Record<string, unknown>;
    if (mode !== "percent" && mode !== "amount") {
      throw new BulkUpdateError("Invalid price adjustment mode");
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new BulkUpdateError("Invalid price adjustment value");
    }
    if (mode === "percent" && (value < -99 || value > 1000)) {
      throw new BulkUpdateError("Percent adjustment must be between -99 and 1000");
    }
    if (mode === "amount" && (value < -1_000_000 || value > 1_000_000)) {
      throw new BulkUpdateError("Amount adjustment out of range");
    }
    if (applyTo !== "unitPrice" && applyTo !== "costPrice" && applyTo !== "both") {
      throw new BulkUpdateError("Invalid price adjustment target");
    }
    priceAdjust = { mode, value, applyTo };
  }
  if (
    status === undefined &&
    categoryId === undefined &&
    brandId === undefined &&
    priceAdjust === undefined
  ) {
    throw new BulkUpdateError(
      "Nothing to update — provide status, category, brand, or price adjustment"
    );
  }

  return { ids: ids as string[], status, categoryId, brandId, priceAdjust };
}

/** Apply a percent/amount adjustment to a cents price, clamped at ≥ 0. */
function adjustPrice(cents: number, adj: PriceAdjust): number {
  const next =
    adj.mode === "percent"
      ? Math.round(cents * (1 + adj.value / 100))
      : cents + majorToCents(adj.value);
  return Math.max(0, next);
}

/** Core operation. `userId` is only used for the audit trail. */
export async function bulkUpdateProducts(
  input: BulkUpdateInput,
  userId: string
): Promise<BulkUpdateResult> {
  const { ids, status, categoryId, brandId, priceAdjust } = input;

  if (
    status === undefined &&
    categoryId === undefined &&
    brandId === undefined &&
    priceAdjust === undefined
  ) {
    throw new BulkUpdateError("Nothing to update");
  }

  // Category / brand must exist (defensive — the UI only lists real
  // ones, but the service is a public API surface). "" clears brand.
  if (categoryId) {
    const category = await db.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      throw new BulkUpdateError("Category not found", 404);
    }
  }
  if (brandId) {
    const brand = await db.brand.findUnique({ where: { id: brandId } });
    if (!brand) {
      throw new BulkUpdateError("Brand not found", 404);
    }
  }

  // updateMany cannot do per-row math — price adjustments need one
  // UPDATE per row. Read targets once for both the math and the audit.
  const targets = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, unitPrice: true, costPrice: true },
  });
  if (targets.length === 0) {
    throw new BulkUpdateError("No matching products", 404);
  }

  // Flat fields → one updateMany; price adjustments → per-row updates.
  const flatData = {
    ...(status ? { status } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(brandId !== undefined ? { brandId: brandId || null } : {}),
  };

  let updated = 0;
  if (priceAdjust) {
    // Sequential updates in an interactive transaction: each row's new
    // price derives from its own current price, and a mid-flight failure
    // rolls the whole selection back atomically.
    await db.$transaction(async (tx) => {
      for (const p of targets) {
        const data: Record<string, number> = {};
        if (priceAdjust.applyTo === "unitPrice" || priceAdjust.applyTo === "both") {
          data["unitPrice"] = adjustPrice(p.unitPrice, priceAdjust);
        }
        if (priceAdjust.applyTo === "costPrice" || priceAdjust.applyTo === "both") {
          data["costPrice"] = adjustPrice(p.costPrice, priceAdjust);
        }
        await tx.product.update({
          where: { id: p.id },
          data: { ...data, ...flatData },
        });
        updated += 1;
      }
    });
  } else {
    const result = await db.product.updateMany({
      where: { id: { in: ids } },
      data: flatData,
    });
    updated = result.count;
  }

  await logAudit({
    userId,
    action: "update",
    entity: "product",
    entityId: ids.join(","),
    entityName: `${updated} products (bulk)`,
    newValues: { status, categoryId, brandId, priceAdjust, count: updated },
  });

  return { updated };
}
