import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { stockStatusForRow } from "@/lib/inventory/stock-status";

/* ═══════════════════════════════════════════════════════════════
   WAREHOUSE STOCK SUMMARY API
   GET /api/warehouses/stock-summary — Aggregate stock valuation
   breakdown across all warehouses with product counts.
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const stockLevels = await db.stockLevel.findMany({
      // Variant stock rows are excluded so valuations and product counts
      // don't double-count "Family Pack" units under the base product.
      where: { variantId: null },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            unitPrice: true,
            costPrice: true,
            unit: true,
            status: true,
            minStockLevel: true,
            allowFractional: true,
            category: { select: { name: true } },
          },
        },
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });

    // Aggregate by warehouse
    const warehouseMap = new Map<
      string,
      {
        id: string;
        name: string;
        code: string;
        totalQuantity: number;
        totalCostValue: number;
        totalRetailValue: number;
        productCount: number;
        lowStockCount: number;
        outOfStockCount: number;
      }
    >();

    for (const sl of stockLevels) {
      const whId = sl.warehouseId;
      if (!warehouseMap.has(whId)) {
        warehouseMap.set(whId, {
          id: sl.warehouse.id,
          name: sl.warehouse.name,
          code: sl.warehouse.code,
          totalQuantity: 0,
          totalCostValue: 0,
          totalRetailValue: 0,
          productCount: 0,
          lowStockCount: 0,
          outOfStockCount: 0,
        });
      }

      const wh = warehouseMap.get(whId)!;
      wh.totalQuantity += sl.quantity;
      wh.totalCostValue += sl.quantity * sl.product.costPrice;
      wh.totalRetailValue += sl.quantity * sl.product.unitPrice;
      wh.productCount += 1;

      // Shared classification (lib/stock-status) — same rule as the
      // Inventory page and dashboard counter (reserved reduces sellable).
      const status = stockStatusForRow(sl, sl.product.minStockLevel);
      if (status === "out") wh.outOfStockCount++;
      else if (status === "low") wh.lowStockCount++;
    }

    const warehouses = Array.from(warehouseMap.values()).sort(
      (a, b) => b.totalCostValue - a.totalCostValue
    );

    // Overall summary
    // DISTINCT products, not stockLevels.length — a product stocked in three
    // warehouses is one product, and the field is literally named totalProducts.
    const distinctProducts = new Set(stockLevels.map((sl) => sl.product.id)).size;

    const summary = {
      totalWarehouses: warehouses.length,
      totalProducts: distinctProducts,
      /** Stock rows (product × warehouse) behind totalProducts. */
      totalStockRows: stockLevels.length,
      totalQuantity: warehouses.reduce((s, w) => s + w.totalQuantity, 0),
      totalCostValue: warehouses.reduce((s, w) => s + w.totalCostValue, 0),
      totalRetailValue: warehouses.reduce((s, w) => s + w.totalRetailValue, 0),
      potentialProfit:
        warehouses.reduce((s, w) => s + w.totalRetailValue, 0) -
        warehouses.reduce((s, w) => s + w.totalCostValue, 0),
      profitMargin:
        warehouses.reduce((s, w) => s + w.totalRetailValue, 0) > 0
          ? Math.round(
              ((warehouses.reduce((s, w) => s + w.totalRetailValue, 0) -
                warehouses.reduce((s, w) => s + w.totalCostValue, 0)) /
                warehouses.reduce((s, w) => s + w.totalRetailValue, 0)) *
                100
            )
          : 0,
      lowStockCount: warehouses.reduce((s, w) => s + w.lowStockCount, 0),
      outOfStockCount: warehouses.reduce((s, w) => s + w.outOfStockCount, 0),
    };

    return NextResponse.json({ summary, warehouses });
  } catch (error) {
    console.error("[WAREHOUSE_STOCK_SUMMARY]", error);
    return apiError("Internal server error", 500);
  }
}
