import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { parsePagination } from "@/lib/pagination";
import { needsRestock, stockStatusForRow } from "@/lib/stock-status";

/* ═══════════════════════════════════════════════════════════════
   INVENTORY API
   GET  /api/inventory          — List stock levels with filters
   POST /api/inventory/adjust   — Adjust stock (see /adjust route)
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const warehouseId = searchParams.get("warehouseId") ?? undefined;
    const search = searchParams.get("search") ?? "";
    const lowStock = searchParams.get("lowStock") === "true";
    // `all=true` returns every row in scope, unpaginated. The Inventory page
    // needs the whole filtered set: its stock table, its CSV/Excel export and
    // its printed valuation all read the loaded rows, so with paging they
    // silently showed and exported just the first page (50 rows) of a catalog
    // that can hold far more.
    const all = searchParams.get("all") === "true";
    const { page, pageSize } = parsePagination(searchParams, {
      defaultPageSize: 50,
    });

    const where: Record<string, unknown> = {
      // CONSISTENCY: never show soft-deleted products (ghost rows with
      // leftover stock would disagree with the Products/POS pages) and
      // only active warehouses — the same scope the low-stock alert
      // engine (lib/low-stock scanLowStock) uses.
      product: { deletedAt: null },
      warehouse: { isActive: true },
    };

    if (warehouseId) where["warehouseId"] = warehouseId;

    if (search) {
      where["product"] = {
        ...(where["product"] as Record<string, unknown>),
        AND: [
          {
            OR: [
              { name: { contains: search } },
              { sku: { contains: search } },
              { barcode: { contains: search } },
            ],
          },
        ],
      };
    }



    const items = await db.stockLevel.findMany({
      where,
      include: {
        product: {
          select: {
            id: true, name: true, sku: true, barcode: true,
            minStockLevel: true, maxStockLevel: true, unitPrice: true, costPrice: true,
            unit: true, allowFractional: true, sellByValue: true,
            category: { select: { name: true } },
          },
        },
        warehouse: { select: { id: true, name: true, code: true } },
      },
      orderBy: { product: { name: "asc" } },
    });

    // Tallies for the Inventory KPI cards, computed over EVERY row in scope —
    // before the low-stock filter and before pagination. They used to be derived
    // from the loaded page client-side, which capped them at the page size (the
    // default page is 50 rows, and the catalog can hold far more) and made them
    // jump whenever the filter or a search was toggled.
    const summary = {
      stockRows: items.length,
      lowStockCount: 0,
      outOfStockCount: 0,
      totalStockValue: 0,
      totalRetailValue: 0,
    };
    for (const sl of items) {
      const status = stockStatusForRow(sl, sl.product.minStockLevel);
      if (status === "low") summary.lowStockCount++;
      else if (status === "out") summary.outOfStockCount++;
      summary.totalStockValue += sl.quantity * sl.product.costPrice;
      summary.totalRetailValue += sl.quantity * sl.product.unitPrice;
    }

    // Post-process: keep only rows flagged by the SHARED rule (lib/stock-status
    // — reserved units reduce sellable stock). This is the restock worklist, so
    // out-of-stock rows stay in it: hiding the most urgent rows behind a
    // "low stock" filter would be worse than the label being loose.
    const filteredItems = lowStock
      ? items.filter((sl) => needsRestock(stockStatusForRow(sl, sl.product.minStockLevel)))
      : items;

    const total = filteredItems.length;
    const pageItems = all
      ? filteredItems
      : filteredItems.slice((page - 1) * pageSize, page * pageSize);

    // Shared classification (lib/stock-status): one low/out rule for
    // every page — the Products page, POS grid and dashboard counter
    // now show the same status for the same numbers.
    const enriched = pageItems.map((sl) => {
      const available = sl.quantity - sl.reservedQuantity;
      const status = stockStatusForRow(sl, sl.product.minStockLevel);
      return {
        ...sl,
        available,
        stockStatus: status,
        isLowStock: status === "low",
        isOutOfStock: status === "out",
        stockValue: sl.quantity * sl.product.costPrice,
      };
    });

    return NextResponse.json({
      items: enriched,
      summary,
      total,
      page: all ? 1 : page,
      pageSize: all ? total : pageSize,
      totalPages: all ? 1 : Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("[INVENTORY_GET]", error);
    return apiError("Internal server error", 500);
  }
}
