import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { summarizeLowStock } from "@/lib/stock-status";
import { revenueStatuses, openCreditOrderWhere, sumRevenue } from "@/lib/report-math";

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD API
   Aggregates data from multiple tables for the dashboard view.
   Optional `?warehouseId=<id>` scopes every widget (revenue, trend,
   heatmap, top products/customers, statuses, dues, refunds and the
   low-stock count) to that single warehouse; the parameter is
   ignored unless the warehouse exists, so an unknown id silently
   falls back to all-warehouse data.

   Optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, local time)
   date-filters the KPIs, trend series, hourly view, recent orders,
   top products/customers and the status breakdown. The headline KPI
   becomes "revenue over the range" with a delta against the equal-
   length window immediately before it. Ranges of ≤ 7 days get a
   per-day trend series; longer ranges are bucketed per calendar
   month. The hourly card is only populated for single-day ranges.
   Refund analytics keep their rolling 6-month window and dues keep
   their all-time/open-balance semantics regardless of range.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("dashboard:view");
    if (response) return response;

    // Optional per-warehouse scope. Only a *real* warehouse id narrows
    // the queries — anything else (missing/unknown) means "all".
    const warehouseParam = request.nextUrl.searchParams.get("warehouseId");
    const scopedWarehouse = warehouseParam
      ? await db.warehouse.findUnique({ where: { id: warehouseParam }, select: { id: true } })
      : null;
    const whScope = scopedWarehouse ? { warehouseId: scopedWarehouse.id } : {};

    // Optional date range (`from`/`to` as YYYY-MM-DD, inclusive).
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Missing/invalid values mean "today", which reproduces the old
    // single-day behavior exactly.
    const parseDate = (key: string): Date | null => {
      const raw = request.nextUrl.searchParams.get(key);
      if (!raw) return null;
      const d = new Date(`${raw}T00:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const rangeFrom = parseDate("from") ?? todayStart;
    const toParam = parseDate("to");
    const rangeDaysRaw = toParam
      ? Math.round((toParam.getTime() + 24 * 60 * 60 * 1000 - rangeFrom.getTime()) / 86400000)
      : 1;
    const rangeDays = Math.max(1, rangeDaysRaw);
    const rangeTo = new Date(rangeFrom.getTime() + rangeDays * 24 * 60 * 60 * 1000); // exclusive end

    /** Local YYYY-MM-DD of a Date — `toISOString` would shift the calendar
     *  day for any store not running on UTC and mislabel every bucket. */
    const localDay = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const prevRangeFrom = new Date(rangeFrom.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    const rangeWindow = { createdAt: { gte: rangeFrom, lt: rangeTo } };
    const granularity: "daily" | "monthly" = rangeDays <= 7 ? "daily" : "monthly";

    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const trendStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    trendStart.setHours(0, 0, 0, 0);
    // Start of the month 5 months back → a rolling 6-calendar-month refund window
    const refundWindowStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    // Hourly breakdown window: the single-day range when from==to
    // (defaults to today). For longer ranges the window is empty
    // (gte rangeTo && lt rangeTo) so the hourly query returns nothing.
    const hourlyStart = rangeDays === 1 ? rangeFrom : rangeTo;
    const hourlyEnd = rangeTo;

    const [
      rangeStats,
      prevRangeStats,
      monthStats,
      prevMonthStats,
      totalProducts,
      lowStockProducts,
      recentOrders,
      topSellingProducts,
      trendOrders,
      todayOrdersRaw,
      topCustomers,
      orderStatusBreakdown,
      outstandingDues,
      warehouseTotals,
      refundedOrders,
    ] = await Promise.all([
      // Revenue over the selected range (headline KPI)
      db.order.aggregate({
        where: {
          createdAt: { gte: rangeFrom, lt: rangeTo },
          status: { in: revenueStatuses() },
          ...whScope,
        },
        _sum: { total: true },
        _count: true,
      }),

      // The equal-length window immediately before the range (for the
      // "vs previous period" delta on the headline KPI)
      db.order.aggregate({
        where: {
          createdAt: { gte: prevRangeFrom, lt: rangeFrom },
          status: { in: revenueStatuses() },
          ...whScope,
        },
        _sum: { total: true },
        _count: true,
      }),

      // Month-to-date orders (secondary KPI)
      db.order.aggregate({
        where: {
          createdAt: { gte: monthStart, lt: rangeTo > monthStart ? rangeTo : monthStart },
          status: { in: revenueStatuses() },
          ...whScope,
        },
        _sum: { total: true },
        _count: true,
      }),

      // Previous calendar month (for month-over-month comparison)
      db.order.aggregate({
        where: {
          createdAt: { gte: prevMonthStart, lt: monthStart },
          status: { in: revenueStatuses() },
          ...whScope,
        },
        _sum: { total: true },
      }),

      // Total products
      db.product.count({
        where: { status: "active", deletedAt: null },
      }),

      // Low stock products. No quantity cap here on purpose: the threshold
      // is each product's OWN minStockLevel (which can be > 10), so we load
      // tracked active levels and compare in JS below. Variant rows are
      // excluded (their stock is tracked/sold separately) and the count is
      // DISTINCT products — the raw row count used to double-count a
      // product stocked in two warehouses as two "low stock products".
      db.stockLevel.findMany({
        where: {
          variantId: null,
          ...whScope,
          warehouse: { isActive: true },
          product: { status: "active", deletedAt: null, trackInventory: true },
        },
        select: {
          quantity: true,
          reservedQuantity: true,
          product: { select: { id: true, minStockLevel: true, allowFractional: true } },
        },
      }),

      // Recent orders within the range
      db.order.findMany({
        where: { ...whScope, createdAt: { gte: rangeFrom, lt: rangeTo } },
        take: 8,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { name: true } },
          customer: { select: { name: true } },
        },
      }),

      // Top selling products (by order quantity in last 30 days)
      db.orderItem.groupBy({
        by: ["productName"],
        where: {
          order: {
            createdAt: { gte: rangeFrom, lt: rangeTo },
            status: { in: revenueStatuses() },
            ...whScope,
          },
        },
        _sum: { quantity: true, total: true },
        orderBy: { _sum: { quantity: "desc" } },
        take: 5,
      }),

      // Orders across the trend window (per-day or per-month buckets).
      // Daily granularity fetches the union of the range and the rolling
      // last-7-days window (the sales heatmap is always last-7-days);
      // monthly buckets extend to the month boundaries containing the
      // range so first/last months include their partial data.
      db.order.findMany({
        where: {
          createdAt: {
            gte:
              granularity === "daily"
                ? new Date(Math.min(rangeFrom.getTime(), trendStart.getTime()))
                : new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), 1),
            lt:
              granularity === "daily"
                ? new Date(Math.max(rangeTo.getTime(), now.getTime()))
                : new Date(rangeTo.getFullYear(), rangeTo.getMonth() + 1, 1),
          },
          status: { in: revenueStatuses() },
          ...whScope,
        },
        select: { createdAt: true, total: true },
      }),

      // Orders for the hourly breakdown — only meaningful for a single-
      // day range (see `hourlyStart` below); otherwise fetched empty so
      // the extra query costs nothing on multi-day/month ranges.
      db.order.findMany({
        where: {
          createdAt: { gte: hourlyStart, lt: hourlyEnd },
          status: { in: revenueStatuses() },
          ...whScope,
        },
        select: { createdAt: true, total: true },
      }),

      // Top customers by revenue over the range
      db.order.groupBy({
        by: ["customerId"],
        where: {
          createdAt: { gte: rangeFrom, lt: rangeTo },
          status: { in: revenueStatuses() },
          customerId: { not: null },
          ...whScope,
        },
        _sum: { total: true },
        _count: true,
        orderBy: { _sum: { total: "desc" } },
        take: 5,
      }),

      // Order status breakdown over the range
      db.order.groupBy({
        by: ["status"],
        where: { ...whScope, createdAt: { gte: rangeFrom, lt: rangeTo } },
        _count: true,
        _sum: { total: true },
      }),

      // Outstanding credit (khata) dues across all customers — the money
      // the store is still owed on partial/unpaid credit orders.
      db.order.aggregate({
        where: { ...openCreditOrderWhere(), ...whScope },
        _sum: { dueAmount: true },
        _count: true,
      }),

      // Per-warehouse revenue + orders over the range, for the
      // warehouse-comparison card. All warehouses are returned so the
      // client can render every location with a zero baseline.
      db.order.groupBy({
        by: ["warehouseId"],
        where: {
          createdAt: { gte: rangeFrom, lt: rangeTo },
          status: { in: revenueStatuses() },
        },
        _sum: { total: true },
        _count: true,
      }),

      // Refunded orders in the last 6 calendar months (refund trend chart + reason
      // breakdown). Partially refunded orders are included; value uses the
      // actually-returned refundedAmount (full refunds carry refundedAmount === total).
      db.order.findMany({
        where: {
          status: { in: ["refunded", "partially_refunded"] },
          refundedAt: { not: null, gte: refundWindowStart },
          ...whScope,
        },
        select: { refundedAt: true, total: true, refundedAmount: true, refundReason: true },
      }),
    ]);

    // Shared low-stock rule (lib/stock-status): reserved units reduce the
    // sellable quantity, each product is counted once (distinct ids), and the
    // out/low split is derived from the same pass. This is the ONLY reason the
    // "Low Stock" card is comparable with the "Products" card — see
    // summarizeLowStock for why counting rows inflated it.
    const lowStockSummary = summarizeLowStock(
      lowStockProducts.map((sl) => ({
        productId: sl.product.id,
        quantity: sl.quantity,
        reservedQuantity: sl.reservedQuantity,
        minStockLevel: sl.product.minStockLevel,
        allowFractional: sl.product.allowFractional,
      }))
    );

    // Active warehouses for the comparison card (zero-filled client-side
    // for locations without sales in the range).
    const warehousesForComparison = await db.warehouse.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { isDefault: "desc" },
    });

    // Revenue-trend series. ≤7-day ranges bucket per day over the range
    // itself; longer ranges bucket per calendar month (partial first/last
    // months included). `trendPeriod` tells the chart card which
    // granularity it's rendering so it can subtitle itself.
    // Number of calendar months the range touches (for monthly buckets).
    const rangeMonths =
      (rangeTo.getFullYear() - rangeFrom.getFullYear()) * 12 +
      (rangeTo.getMonth() - rangeFrom.getMonth()) + 1;

    const trendBuckets =
      granularity === "daily"
        ? Array.from({ length: rangeDays }, (_, i) => {
            const dayStart = new Date(rangeFrom.getTime() + i * 86400000);
            const dayEnd = new Date(dayStart.getTime() + 86400000);
            const dayOrders = trendOrders.filter((o) => o.createdAt >= dayStart && o.createdAt < dayEnd);
            return {
              date: localDay(dayStart),
              revenue: sumRevenue(dayOrders),
              orders: dayOrders.length,
            };
          })
        : Array.from({ length: rangeMonths }, (_, i) => {
            const ym = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth() + i, 1);
            const nextYm = new Date(ym.getFullYear(), ym.getMonth() + 1, 1);
            const from = i === 0 ? rangeFrom : ym;
            const to = i === rangeMonths - 1 ? rangeTo : nextYm;
            const monthOrders = trendOrders.filter((o) => o.createdAt >= from && o.createdAt < to);
            return {
              date: `${ym.getFullYear()}-${String(ym.getMonth() + 1).padStart(2, "0")}-01`,
              revenue: sumRevenue(monthOrders),
              orders: monthOrders.length,
            };
          });
    const weekTrend = trendBuckets.map((b) => ({
      date: b.date,
      revenue: b.revenue,
      orders: b.orders,
    }));
    const trendPeriod: "day" | "month" = granularity === "daily" ? "day" : "month";

      // Bucket the hourly-focus day into 24 slots (0..23). For ranges
      // longer than one day todayOrdersRaw is empty → all-zero series.
      const todayHourly = Array.from({ length: 24 }, (_, hour) => {
        const hourStart = new Date(hourlyStart.getTime() + hour * 60 * 60 * 1000);
        const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
        const hourOrders = todayOrdersRaw.filter(
          (o) => o.createdAt >= hourStart && o.createdAt < hourEnd
        );
        return {
          hour,
          revenue: sumRevenue(hourOrders),
          orders: hourOrders.length,
        };
      });

      // Per-warehouse comparison over the range (zero-filled for
      // warehouses without sales so every location renders).
      const warehouseComparison = warehousesForComparison.map((w) => {
        const agg = warehouseTotals.find((t) => t.warehouseId === w.id);
        return {
          warehouseId: w.id,
          name: w.name,
          revenue: agg?._sum.total ?? 0,
          orders: agg?._count,
        };
      });

      // Bucket refunds into the last 6 calendar months (oldest → newest)
      const refundTrend = Array.from({ length: 6 }, (_, i) => {
        const ym = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
        const monthKey = `${ym.getFullYear()}-${String(ym.getMonth() + 1).padStart(2, "0")}`;
        const from = new Date(ym.getFullYear(), ym.getMonth(), 1);
        const to = new Date(ym.getFullYear(), ym.getMonth() + 1, 1);
        const monthRefunds = refundedOrders.filter(
          (o) => o.refundedAt && o.refundedAt >= from && o.refundedAt < to
        );
        return {
          month: monthKey,
          count: monthRefunds.length,
          total: monthRefunds.reduce((s, o) => s + (o.refundedAmount || o.total), 0),
        };
      });

      // Bucket the last 7 days × 24 hours for the sales heatmap (local days —
    // the client renders the date labels straight from these keys)
      const weekHourly = Array.from({ length: 7 }, (_, day) => {
        const dayStart = new Date(trendStart.getTime() + day * 24 * 60 * 60 * 1000);
        return Array.from({ length: 24 }, (_, hour) => {
          const hourStart = new Date(dayStart.getTime() + hour * 60 * 60 * 1000);
          const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
          const hourOrders = trendOrders.filter(
            (o) => o.createdAt >= hourStart && o.createdAt < hourEnd
          );
          return {
            date: localDay(dayStart),
            hour,
            revenue: sumRevenue(hourOrders),
            orders: hourOrders.length,
          };
        });
      }).flat();

      // Group refunded orders by recorded reason (last 6 calendar months),
      // sorted by total refunded value. Null/empty reasons are bucketed
      // under a localized "No reason recorded" label on the client.
      const reasonMap = new Map<string, { count: number; total: number }>();
      for (const o of refundedOrders) {
        const key = o.refundReason?.trim() ? o.refundReason.trim() : "__none__";
        const cur = reasonMap.get(key) ?? { count: 0, total: 0 };
        cur.count += 1;
        cur.total += o.refundedAmount || o.total;
        reasonMap.set(key, cur);
      }
      const refundReasons = Array.from(reasonMap.entries())
        .map(([reason, agg]) => ({
          reason: reason === "__none__" ? null : reason,
          count: agg.count,
          total: agg.total,
        }))
        .sort((a, b) => b.total - a.total || b.count - a.count)
        .slice(0, 5);


    // Resolve top customer names + warehouse names for the comparison card
    const topCustomerIds = topCustomers.map((tc) => tc.customerId).filter(Boolean) as string[];
    const topCustomerRecords = topCustomerIds.length > 0
      ? await db.customer.findMany({ where: { id: { in: topCustomerIds } }, select: { id: true, name: true } })
      : [];
    const topCustomerMap = new Map(topCustomerRecords.map((c) => [c.id, c.name]));

    return NextResponse.json({
      // Headline KPI = revenue over the selected range; deltas compare
      // against the equal-length window immediately before it.
      rangeRevenue: rangeStats._sum.total ?? 0,
      rangeOrders: rangeStats._count,
      prevRangeRevenue: prevRangeStats._sum.total ?? 0,
      prevRangeOrders: prevRangeStats._count,
      monthRevenue: monthStats._sum.total ?? 0,
      monthOrders: monthStats._count,
      prevMonthRevenue: prevMonthStats._sum.total ?? 0,
      totalProducts,
      lowStockCount: lowStockSummary.total,
      lowStockOutCount: lowStockSummary.out,
      lowStockLowCount: lowStockSummary.low,
      topCustomers: topCustomers.map((tc) => ({
        name: topCustomerMap.get(tc.customerId!) ?? "Unknown",
        revenue: tc._sum.total ?? 0,
        orders: tc._count,
      })),
      outstandingDues: outstandingDues._sum.dueAmount ?? 0,
      outstandingDuesOrders: outstandingDues._count,
      orderStatusBreakdown: orderStatusBreakdown.map((os) => ({
        status: os.status,
        count: os._count,
        total: os._sum.total ?? 0,
      })),
      recentOrders: recentOrders.map((o) => ({
        ...o,
        total: o.total,
      })),
      topProducts: topSellingProducts.map((tp) => ({
        name: tp.productName,
        totalSold: tp._sum.quantity ?? 0,
        revenue: tp._sum.total ?? 0,
      })),
      weekTrend,
      trendPeriod,
      todayHourly,
      weekHourly,
      refundTrend,
      refundReasons,
      rangeMeta: {
        from: localDay(rangeFrom),
        to: localDay(new Date(rangeTo.getTime() - 86400000)),
        days: rangeDays,
        granularity,
      },
      warehouseComparison,
    });
  } catch (error) {
    console.error("[DASHBOARD_API]", error);
    return NextResponse.json(
      {
        rangeRevenue: 0,
        rangeOrders: 0,
        prevRangeRevenue: 0,
        prevRangeOrders: 0,
        monthRevenue: 0,
        monthOrders: 0,
        prevMonthRevenue: 0,
        totalProducts: 0,
        lowStockCount: 0,
        lowStockOutCount: 0,
        lowStockLowCount: 0,
        outstandingDues: 0,
        outstandingDuesOrders: 0,
        topCustomers: [],
        orderStatusBreakdown: [],
        recentOrders: [],
        topProducts: [],
        weekTrend: [],
        trendPeriod: "day",
        todayHourly: [],
        weekHourly: [],
        refundTrend: [],
        refundReasons: [],
        warehouseComparison: [],
      },
      { status: 500 }
    );
  }
}
