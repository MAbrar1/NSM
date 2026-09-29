import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { parseQueryDateStart, parseQueryDateEnd } from "@/lib/query-date";
import { netOf, revenueStatuses } from "@/lib/report-math";

/* ═══════════════════════════════════════════════════════════════
   SALES REPORT API
   GET /api/reports/sales — Aggregated sales data with date range.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("reports:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");
    const _groupBy = searchParams.get("groupBy") ?? "day"; // day, week, month — reserved for future use

    // Default: last 30 days. dateFrom/dateTo are local YYYY-MM-DD days —
    // parse them at local midnight/end so the window matches the picker
    // (a UTC parse shifts the day for stores behind UTC).
    const now = new Date();
    const startDate =
      parseQueryDateStart(dateFrom) ??
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const endDate = parseQueryDateEnd(dateTo) ?? now;

    const where = {
      createdAt: { gte: startDate, lte: endDate },
      status: { in: revenueStatuses() },
    };

    // Overall summary
    const [summary, orderCount, topProducts, categoryBreakdown, dailyTrends, paymentBreakdown] = await Promise.all([
      db.order.aggregate({
        where,
        _sum: { total: true, taxAmount: true, discountAmount: true, subtotal: true },
        _avg: { total: true },
        _count: true,
      }),

      // Count by status
      db.order.groupBy({
        by: ["status"],
        where: { createdAt: { gte: startDate, lte: endDate } },
        _count: true,
      }),

      // Top selling products (grouped by sale unit so kg/g/L rows stay honest)
      db.orderItem.groupBy({
        by: ["productName", "sku", "unit"],
        where: { order: where },
        _sum: { quantity: true, total: true },
        _count: true,
        orderBy: { _sum: { total: "desc" } },
        take: 10,
      }),

      // Category breakdown
      db.orderItem.findMany({
        where: { order: where },
        select: {
          total: true,
          quantity: true,
          product: {
            select: {
              category: { select: { name: true } },
            },
          },
        },
      }),

      // Daily trends — fetch the raw orders and bucket in JS so the query
      // stays portable across SQLite/Postgres (no date()/strftime dialect).
      db.order.findMany({
        where,
        select: { createdAt: true, total: true, discountAmount: true },
      }),

      // Payment method breakdown
      db.payment.groupBy({
        by: ["method"],
        where: {
          status: "completed",
          order: { createdAt: { gte: startDate, lte: endDate } },
        },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    // Process category breakdown
    const categoryMap = new Map<string, { revenue: number; quantity: number; items: number }>();
    for (const item of categoryBreakdown) {
      const catName = item.product.category.name;
      const existing = categoryMap.get(catName) ?? { revenue: 0, quantity: 0, items: 0 };
      existing.revenue += item.total;
      existing.quantity += item.quantity;
      existing.items += 1;
      categoryMap.set(catName, existing);
    }
    const categories = Array.from(categoryMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.revenue - a.revenue);

    // Bucket orders into calendar-day rows (oldest → newest), keyed on
    // the store's LOCAL calendar day (UTC keys shift the day for UTC− stores).
    const dailyMap = new Map<string, { revenue: number; netRevenue: number; orders: number }>();
    for (const o of dailyTrends) {
      const d = o.createdAt;
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const cur = dailyMap.get(day) ?? { revenue: 0, netRevenue: 0, orders: 0 };
      cur.revenue += o.total;
      cur.netRevenue += netOf(o.total, o.discountAmount);
      cur.orders += 1;
      dailyMap.set(day, cur);
    }
    const dailyTrendRows = Array.from(dailyMap.entries())
      .map(([date, d]) => ({ date, ...d }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({
      summary: {
        totalRevenue: summary._sum.total ?? 0,
        totalTax: summary._sum.taxAmount ?? 0,
        totalDiscounts: summary._sum.discountAmount ?? 0,
        // Net revenue = what the store actually keeps after discounts
        // (consistent with the per-day netRevenue rows)
        netRevenue: netOf(summary._sum.total ?? 0, summary._sum.discountAmount ?? 0),
        averageOrderValue: summary._avg.total ?? 0,
        totalOrders: summary._count,
      },
      statusBreakdown: orderCount.map((s) => ({ status: s.status, count: s._count })),
      topProducts: topProducts.map((p) => ({
        name: p.productName,
        sku: p.sku,
        unit: p.unit,
        quantitySold: p._sum.quantity ?? 0,
        revenue: p._sum.total ?? 0,
        orderCount: p._count,
      })),
      categories,
      dailyTrends: dailyTrendRows,
      paymentMethods: paymentBreakdown.map((p) => ({
        method: p.method,
        total: p._sum.amount ?? 0,
        count: p._count,
      })),
      dateRange: {
        from: startDate.toISOString(),
        to: endDate.toISOString(),
      },
    });
  } catch (error) {
    console.error("[SALES_REPORT]", error);
    return apiError("Internal server error", 500);
  }
}
