import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { parseQueryDateStart, parseQueryDateEnd } from "@/lib/api/query-date";
import {
  lineCogs,
  netOf,
  marginPercent,
  averageOrderValue,
  revenueStatuses,
  revenueOf,
} from "@/lib/reports/report-math";

/* ═══════════════════════════════════════════════════════════════
   PROFIT & LOSS API
   GET /api/reports/profit-loss — Revenue, COGS, net profit with date range.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("reports:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");

    const now = new Date();
    // dateFrom/dateTo are local YYYY-MM-DD days — parse at local
    // midnight/end so the window matches the date picker exactly.
    const startDate =
      parseQueryDateStart(dateFrom) ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = parseQueryDateEnd(dateTo) ?? now;

    const orderWhere = {
      createdAt: { gte: startDate, lte: endDate },
      status: { in: revenueStatuses() },
    };

    // Revenue from completed orders
    const revenueData = await db.order.aggregate({
      where: orderWhere,
      _sum: { taxAmount: true, discountAmount: true, total: true },
      _count: true,
    });

    // Cost of Goods Sold (COGS) — sum of costPrice * quantity from order items
    const cogsData = await db.orderItem.findMany({
      where: { order: orderWhere },
      select: { costPrice: true, quantity: true },
    });
    const totalCOGS = cogsData.reduce((sum, item) => sum + lineCogs(item.costPrice, item.quantity), 0);
    // Revenue basis = Order.total (see lib/report-math.revenueOf). This used
    // to be `subtotal`, which disagreed with the dashboard, the sales report
    // and the Customers page for the same period.
    const totalRevenue = revenueData._sum.total ?? 0;
    const grossProfit = netOf(totalRevenue, totalCOGS);
    const grossMargin = marginPercent(totalRevenue, totalCOGS);

    // Monthly trends (last 6 months). Fetch the whole window in TWO batched
    // queries (orders + items) and bucket in JS — the old loop ran 12
    // queries (2 × 6 months) and got slower as the order history grew.
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const trendEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const [monthlyOrders, monthlyItems] = await Promise.all([
      db.order.findMany({
        where: {
          createdAt: { gte: trendStart, lte: trendEnd },
          status: { in: revenueStatuses() },
        },
        select: { createdAt: true, total: true },
      }),
      db.orderItem.findMany({
        where: {
          order: {
            createdAt: { gte: trendStart, lte: trendEnd },
            status: { in: revenueStatuses() },
          },
        },
        select: { costPrice: true, quantity: true, order: { select: { createdAt: true } } },
      }),
    ]);

    const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthStats = new Map<string, { revenue: number; cogs: number; orders: number }>();
    for (const o of monthlyOrders) {
      const key = monthKey(o.createdAt);
      const cur = monthStats.get(key) ?? { revenue: 0, cogs: 0, orders: 0 };
      cur.revenue += revenueOf(o);
      cur.orders += 1;
      monthStats.set(key, cur);
    }
    for (const item of monthlyItems) {
      const key = monthKey(item.order.createdAt);
      const cur = monthStats.get(key) ?? { revenue: 0, cogs: 0, orders: 0 };
      cur.cogs += lineCogs(item.costPrice, item.quantity);
      monthStats.set(key, cur);
    }

    const monthlyData = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = monthKey(monthStart);
      const stats = monthStats.get(key) ?? { revenue: 0, cogs: 0, orders: 0 };
      const monthGP = netOf(stats.revenue, stats.cogs);

      monthlyData.push({
        month: monthStart.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        revenue: stats.revenue,
        cogs: stats.cogs,
        grossProfit: monthGP,
        orders: stats.orders,
        averageOrderValue: averageOrderValue(stats.revenue, stats.orders),
      });
    }

    // Category profitability
    const categoryItems = await db.orderItem.findMany({
      where: { order: orderWhere },
      select: {
        total: true,
        costPrice: true,
        quantity: true,
        product: { select: { category: { select: { name: true } } } },
      },
    });

    const catMap = new Map<string, { revenue: number; cogs: number; quantity: number }>();
    for (const item of categoryItems) {
      const name = item.product.category.name;
      const existing = catMap.get(name) ?? { revenue: 0, cogs: 0, quantity: 0 };
      existing.revenue += item.total;
      existing.cogs += lineCogs(item.costPrice, item.quantity);
      existing.quantity += item.quantity;
      catMap.set(name, existing);
    }
    const categoryProfitability = Array.from(catMap.entries())
      .map(([name, data]) => ({
        name,
        revenue: data.revenue,
        cogs: data.cogs,
        grossProfit: netOf(data.revenue, data.cogs),
        margin: marginPercent(data.revenue, data.cogs),
        quantity: data.quantity,
      }))
      .sort((a, b) => b.grossProfit - a.grossProfit);

    // Payment method breakdown
    const payments = await db.payment.groupBy({
      by: ["method"],
      where: {
        status: "completed",
        order: orderWhere,
      },
      _sum: { amount: true },
      _count: true,
    });

    return NextResponse.json({
      summary: {
        totalRevenue,
        totalCOGS,
        grossProfit,
        grossMargin,
        totalTax: revenueData._sum.taxAmount ?? 0,
        totalDiscounts: revenueData._sum.discountAmount ?? 0,
        totalOrders: revenueData._count,
        averageOrderValue: averageOrderValue(totalRevenue, revenueData._count),
      },
      monthlyData,
      categoryProfitability,
      paymentBreakdown: payments.map((p) => ({
        method: p.method,
        total: p._sum.amount ?? 0,
        count: p._count,
      })),
      dateRange: { from: startDate.toISOString(), to: endDate.toISOString() },
    });
  } catch (error) {
    console.error("[PNL_REPORT]", error);
    return apiError("Internal server error", 500);
  }
}
