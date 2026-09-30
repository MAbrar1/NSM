import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { parseQueryDateStart, parseQueryDateEnd } from "@/lib/api/query-date";

/* ═══════════════════════════════════════════════════════════════
   REFUNDS ANALYTICS API
   GET /api/refunds — Aggregate refund ledger stats for a date
   range plus the monthly refund trend (count + refunded value per
   calendar month, bucketed by when the refund was processed).
   Bucketing happens in JS so the query stays portable across
   SQLite/Postgres (no strftime()/date_trunc() dialect).
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("orders:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const dateFrom = searchParams.get("from");
    const dateTo = searchParams.get("to");

    // Invalid/missing params degrade to "no filter" instead of building an
    // Invalid Date that Prisma rejects with a 500 (see lib/query-date).
    const from = parseQueryDateStart(dateFrom) ?? undefined;
    const to = parseQueryDateEnd(dateTo) ?? undefined;

    const where: { status: { in: string[] }; refundedAt?: { gte?: Date; lte?: Date } } = {
      // Both full and partial refunds belong in the refund analytics; the
      // value buckets use refundedAmount (the actually-returned portion).
      status: { in: ["refunded", "partially_refunded"] },
    };
    if (from || to) {
      where.refundedAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }

    const [agg, refundedOrders] = await Promise.all([
      db.order.aggregate({
        where,
        _count: { _all: true },
        // refundedAmount is the value actually returned (full refunds have
        // refundedAmount === total; partial refunds only the returned part)
        _sum: { refundedAmount: true },
      }),
      db.order.findMany({
        where,
        select: { refundedAt: true, refundedAmount: true, refundReason: true },
      }),
    ]);

    const total = agg._count._all;
    const sumTotal = Number(agg._sum.refundedAmount ?? 0);

    // Bucket refunds into calendar months (oldest → newest)
    const monthMap = new Map<string, { count: number; total: number }>();
    for (const o of refundedOrders) {
      if (!o.refundedAt) continue;
      const d = new Date(o.refundedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const cur = monthMap.get(key) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += o.refundedAmount || 0;
      monthMap.set(key, cur);
    }
    const monthlyTrend = Array.from(monthMap.entries())
      .map(([month, agg2]) => ({ month, ...agg2 }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Group by recorded refund reason, sorted by refunded value
    const reasonMap = new Map<string, { count: number; total: number }>();
    for (const o of refundedOrders) {
      const key = o.refundReason?.trim() ? o.refundReason.trim() : "__none__";
      const cur = reasonMap.get(key) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += o.refundedAmount || 0;
      reasonMap.set(key, cur);
    }
    const reasonBreakdown = Array.from(reasonMap.entries())
      .map(([reason, agg2]) => ({
        reason: reason === "__none__" ? null : reason, // null = "no reason recorded"
        count: agg2.count,
        total: agg2.total,
      }))
      .sort((a, b) => b.total - a.total || b.count - a.count)
      .slice(0, 6);

    return NextResponse.json({
      total,
      sumTotal,
      average: total > 0 ? Math.round(sumTotal / total) : 0,
      monthlyTrend,
      reasons: reasonBreakdown,
    });
  } catch (error) {
    console.error("[REFUNDS_GET]", error);
    return apiError("Internal server error", 500);
  }
}
