import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { stockStatusForRow, sumStockRows } from "@/lib/stock-status";
import {
  stockCostValue,
  stockRetailValue,
  netOf,
  marginPercent,
  revenueStatuses,
} from "@/lib/report-math";

/* ═══════════════════════════════════════════════════════════════
   INVENTORY REPORT API
   GET /api/reports/inventory — Stock valuation, turnover, aging.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("reports:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const warehouseId = searchParams.get("warehouseId") ?? undefined;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // Stock levels with product info. Soft-deleted products are excluded so
    // leftover stock rows can't inflate valuation or low-stock counts.
    const stockWhere: Record<string, unknown> = {
      product: { deletedAt: null },
    };
    if (warehouseId) stockWhere["warehouseId"] = warehouseId;

    const stockLevels = await db.stockLevel.findMany({
      where: stockWhere,
      include: {
        product: {
          select: {
            id: true, name: true, sku: true, unitPrice: true, costPrice: true,
            minStockLevel: true, maxStockLevel: true, status: true,
            allowFractional: true,
            category: { select: { name: true } },
          },
        },
        warehouse: { select: { id: true, name: true, code: true } },
      },
    });

    // Calculate stock valuation
    const totalCostValue = stockLevels.reduce(
      (sum, sl) => sum + stockCostValue(sl.quantity, sl.product.costPrice),
      0
    );
    const totalRetailValue = stockLevels.reduce(
      (sum, sl) => sum + stockRetailValue(sl.quantity, sl.product.unitPrice),
      0
    );
    const totalPotentialProfit = netOf(totalRetailValue, totalCostValue);

    // Stock by category
    const categoryMap = new Map<string, { quantity: number; costValue: number; retailValue: number; items: number }>();
    for (const sl of stockLevels) {
      const cat = sl.product.category.name;
      const existing = categoryMap.get(cat) ?? { quantity: 0, costValue: 0, retailValue: 0, items: 0 };
      existing.quantity += sl.quantity;
      existing.costValue += stockCostValue(sl.quantity, sl.product.costPrice);
      existing.retailValue += stockRetailValue(sl.quantity, sl.product.unitPrice);
      existing.items += 1;
      categoryMap.set(cat, existing);
    }
    const categoryBreakdown = Array.from(categoryMap.entries())
      .map(([name, data]) => ({
        name,
        ...data,
        margin: netOf(data.retailValue, data.costValue),
      }))
      .sort((a, b) => b.costValue - a.costValue);

    // Stock by warehouse
    const warehouseMap = new Map<string, { name: string; code: string; quantity: number; costValue: number }>();
    for (const sl of stockLevels) {
      const key = sl.warehouse.id;
      const existing = warehouseMap.get(key) ?? { name: sl.warehouse.name, code: sl.warehouse.code, quantity: 0, costValue: 0 };
      existing.quantity += sl.quantity;
      existing.costValue += stockCostValue(sl.quantity, sl.product.costPrice);
      warehouseMap.set(key, existing);
    }
    const warehouseBreakdown = Array.from(warehouseMap.values());

    // Product turnover: items sold in last 30 days vs current stock
    const recentSales = await db.orderItem.groupBy({
      by: ["productId"],
      where: {
        order: {
          createdAt: { gte: thirtyDaysAgo },
          status: { in: revenueStatuses() },
        },
      },
      _sum: { quantity: true },
    });

    const salesMap = new Map<string, number>();
    for (const sale of recentSales) {
      salesMap.set(sale.productId, sale._sum.quantity ?? 0);
    }

    // Build turnover data
    const turnoverData = stockLevels
      .filter((sl) => sl.quantity > 0)
      .map((sl) => {
        const sold30d = salesMap.get(sl.productId) ?? 0;
        const dailyRate = sold30d / 30;
        const daysOfStock = dailyRate > 0 ? Math.round(sl.quantity / dailyRate) : Infinity;

        let turnoverCategory: string;
        if (daysOfStock <= 7) turnoverCategory = "Fast Moving";
        else if (daysOfStock <= 30) turnoverCategory = "Normal";
        else if (daysOfStock <= 90) turnoverCategory = "Slow Moving";
        else turnoverCategory = "Dead Stock";

        return {
          productId: sl.product.id,
          productName: sl.product.name,
          sku: sl.product.sku,
          category: sl.product.category.name,
          currentStock: sl.quantity,
          soldLast30Days: sold30d,
          dailyRate: Math.round(dailyRate * 100) / 100,
          daysOfStock: daysOfStock === Infinity ? 999 : daysOfStock,
          turnoverCategory,
          stockValue: stockCostValue(sl.quantity, sl.product.costPrice),
        };
      })
      .sort((a, b) => a.daysOfStock - b.daysOfStock);

    // Aging analysis: products with no sales in 90+ days
    const oldProducts = await db.orderItem.groupBy({
      by: ["productId"],
      where: {
        order: {
          createdAt: { gte: ninetyDaysAgo },
          status: { in: revenueStatuses() },
        },
      },
      _sum: { quantity: true },
    });
    const oldSalesSet = new Set(oldProducts.map((p) => p.productId));

    const agingProducts = stockLevels
      .filter((sl) => sl.quantity > 0 && !oldSalesSet.has(sl.productId))
      .map((sl) => ({
        productName: sl.product.name,
        sku: sl.product.sku,
        category: sl.product.category.name,
        quantity: sl.quantity,
        value: stockCostValue(sl.quantity, sl.product.costPrice),
      }));

    // Summary stats — shared classification (lib/stock-status), so the
    // report's low/out counts match the Inventory page and dashboard.
    const lowStockItems = stockLevels.filter(
      (sl) => stockStatusForRow(sl, sl.product.minStockLevel) === "low"
    );
    // Same classifier as the low count — this used to hand-roll `qty <= 0`,
    // which skips the sellable-units floor and could disagree with the
    // Inventory page's Out-of-Stock KPI for fractional reservations.
    const outOfStockItems = stockLevels.filter(
      (sl) => stockStatusForRow(sl, sl.product.minStockLevel) === "out"
    );
    const excessStockItems = stockLevels.filter(
      (sl) => sl.product.maxStockLevel && sl.quantity > sl.product.maxStockLevel
    );

    return NextResponse.json({
      summary: {
        totalProducts: stockLevels.length,
        totalQuantity: sumStockRows(stockLevels).totalStock,
        totalCostValue,
        totalRetailValue,
        totalPotentialProfit,
        profitMargin: marginPercent(totalRetailValue, totalCostValue),
        lowStockCount: lowStockItems.length,
        outOfStockCount: outOfStockItems.length,
        excessStockCount: excessStockItems.length,
        deadStockCount: turnoverData.filter((t) => t.turnoverCategory === "Dead Stock").length,
      },
      categoryBreakdown,
      warehouseBreakdown,
      turnoverData: turnoverData.slice(0, 50),
      agingProducts,
      turnoverSummary: {
        fastMoving: turnoverData.filter((t) => t.turnoverCategory === "Fast Moving").length,
        normal: turnoverData.filter((t) => t.turnoverCategory === "Normal").length,
        slowMoving: turnoverData.filter((t) => t.turnoverCategory === "Slow Moving").length,
        deadStock: turnoverData.filter((t) => t.turnoverCategory === "Dead Stock").length,
      },
    });
  } catch (error) {
    console.error("[INVENTORY_REPORT]", error);
    return apiError("Internal server error", 500);
  }
}
