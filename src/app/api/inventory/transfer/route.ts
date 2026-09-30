import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { z } from "zod";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { debitStock } from "@/lib/inventory/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   STOCK TRANSFER API
   POST /api/inventory/transfer       — Create a new transfer
   GET  /api/inventory/transfer       — List transfers
   PUT  /api/inventory/transfer/:id   — Update status (receive/cancel)
   ═══════════════════════════════════════════════════════════════ */

const transferItemSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().optional(), // optional — matches StockTransferItem
  quantity: z.number().positive(), // Fractional allowed for weight/volume products
});

const createTransferSchema = z.object({
  fromWarehouseId: z.string().min(1),
  toWarehouseId: z.string().min(1),
  items: z.array(transferItemSchema).min(1, "At least one item required"),
  notes: z.string().max(500).optional(),
});

export const GET = withApiHandler("TRANSFER_GET", async (request) => {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? undefined;

    const where: Record<string, unknown> = {};
    if (status) where["status"] = status;

    const transfers = await db.stockTransfer.findMany({
      where,
      include: {
        fromWarehouse: { select: { name: true, code: true } },
        toWarehouse: { select: { name: true, code: true } },
        createdBy: { select: { name: true } },
        items: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // Enrich with product names in ONE batched query (no per-item lookups).
    const productIds = [...new Set(transfers.flatMap((t) => t.items.map((i) => i.productId)))];
    const products = productIds.length > 0
      ? await db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, sku: true, unit: true, allowFractional: true },
        })
      : [];
    const productById = new Map(products.map((p) => [p.id, p]));

    const enriched = transfers.map((t) => ({
      ...t,
      items: t.items.map((item) => ({
        ...item,
        product: productById.get(item.productId) ?? null,
      })),
    }));

    return NextResponse.json({ transfers: enriched });
  });

export async function POST(request: NextRequest) {
  try {
    // Resolve the acting user from the session
    const { user, response } = await requirePermission("inventory:transfer");
    if (response) return response;

    const body = await request.json();
    const result = createTransferSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = { ...result.data, createdById: user.id };

    if (data.fromWarehouseId === data.toWarehouseId) {
      return apiError("Source and destination warehouses must be different", 400);
    }

    // Create transfer and deduct stock in transaction. The deduction is an
    // atomic conditional UPDATE (WHERE quantity >= requested) so two
    // concurrent transfers can never oversell the same units — a check-then-
    // act loop outside a transaction could race and drive stock negative.
    const transfer = await db.$transaction(async (tx) => {
      const newTransfer = await tx.stockTransfer.create({
        data: {
          fromWarehouseId: data.fromWarehouseId,
          toWarehouseId: data.toWarehouseId,
          status: "pending",
          notes: data.notes,
          createdById: data.createdById,
          items: {
            create: data.items.map((item) => ({
              productId: item.productId,
              variantId: item.variantId || undefined,
              quantity: item.quantity,
            })),
          },
        },
      });

      // Deduct from source warehouse. The stock row is matched on
      // variantId exactly (NULL for non-variant lines) so a variant's
      // transfer never deducts the parent product's stock row.
      for (const item of data.items) {
        // Guarded atomic decrement from the one stock writer; it reports
        // available 0 when the source warehouse has no row at all.
        const taken = await debitStock(
          tx,
          {
            productId: item.productId,
            warehouseId: data.fromWarehouseId,
            variantId: item.variantId ?? null,
          },
          item.quantity
        );
        if (!taken.ok) {
          throw new Error(
            `Insufficient stock for ${item.productId}. Available: ${taken.available}, Requested: ${item.quantity}`
          );
        }

        // Log movement
        await tx.inventoryMovement.create({
          data: {
            productId: item.productId,
            variantId: item.variantId || undefined,
            warehouseId: data.fromWarehouseId,
            type: "transfer",
            quantity: -item.quantity,
            referenceId: newTransfer.id,
            referenceType: "transfer",
            notes: `Transfer OUT to warehouse`,
            performedById: data.createdById,
          },
        });
      }

      return newTransfer;
    });

    return NextResponse.json({ transfer }, { status: 201 });
  } catch (error) {
    // Oversell/availability failures are raised as plain Errors inside the
    // transaction (to roll it back) — surface their message as a 400.
    if (error instanceof Error && /Insufficient stock/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[TRANSFER_POST]", error);
    return apiError("Internal server error", 500);
  }
}
