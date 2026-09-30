import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { parsePagination } from "@/lib/api/pagination";
import { parseSortParam } from "@/lib/table-sort";
import { parseQueryDateStart, parseQueryDateEnd } from "@/lib/api/query-date";

/* ═══════════════════════════════════════════════════════════════
   ORDERS API
   GET /api/orders — List orders with search, status, date filters.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("orders:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? "";
    const status = searchParams.get("status") ?? undefined;
    const dateFrom = parseQueryDateStart(searchParams.get("dateFrom"));
    const dateTo = parseQueryDateEnd(searchParams.get("dateTo"));
    const { page, pageSize, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 20,
    });

    const where: Record<string, unknown> = {};

    if (search) {
      where["OR"] = [
        { orderNumber: { contains: search } },
        { customer: { name: { contains: search } } },
        { user: { name: { contains: search } } },
      ];
    }

    if (status) {
      // Comma-separated statuses (e.g. "refunded,partially_refunded") let
      // the refunds ledger show full and partial refunds in one list.
      const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
      where["status"] = statuses.length > 1 ? { in: statuses } : statuses[0];
    }

    // Refund-reason filter: the refunds ledger lets a reason be clicked to
    // narrow the list to that exact reason. `__none__` selects refunds with
    // no reason recorded (stored as NULL). Applied as an AND-style equality
    // so it never clobbers the search OR clause above.
    const reason = searchParams.get("reason");
    if (reason) {
      where["refundReason"] = reason === "__none__" ? null : reason;
    }

    // Credit (khata) filter: show only orders with open dues. "withDue"
    // covers partial + unpaid credit sales — the collections worklist.
    // The "paid" side is expressed as an AND (all-goods-paid) rather than
    // overwriting `where.OR`, which used to clobber the search clause and
    // return every paid order regardless of the query typed.
    const paymentFilter = searchParams.get("paymentStatus") ?? undefined;
    if (paymentFilter === "withDue") {
      where["dueAmount"] = { gt: 0 };
    } else if (paymentFilter === "paid") {
      const searchOr = where["OR"];
      where["AND"] = [
        { dueAmount: { lte: 0 } },
        ...(Array.isArray(searchOr) && searchOr.length > 0 ? [{ OR: searchOr }] : []),
      ];
      delete where["OR"];
    }

    if (dateFrom || dateTo) {
      // For the refunds ledger, date ranges refer to when the refund was
      // processed (refundedAt); everywhere else they mean order date.
      const isRefundLedger =
        status === "refunded" ||
        (status ?? "").includes("refunded") ||
        (status ?? "").includes("partially_refunded");
      const dateField = isRefundLedger ? "refundedAt" : "createdAt";
      // dateFrom/dateTo are local YYYY-MM-DD days: parse them at local
      // midnight/end (a UTC `new Date(dateFrom)` shifts the window for
      // stores behind UTC and leaks the previous day's orders in).
      where[dateField] = {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      };
    }

    // Allow-listed sort — a hand-edited query falls back to createdAt.desc
    // instead of reaching Prisma's orderBy and throwing. Relation fields
    // (customer, cashier, refundedBy) sort on the related user/customer
    // name. The refunds ledger reuses this endpoint, so its columns
    // (refundedBy, refundedAt, refundReason) are in the same allow-list.
    const orderSort = parseSortParam(
      searchParams.get("sort"),
      ["orderNumber", "customer", "cashier", "refundedBy", "createdAt", "refundedAt", "total", "status", "refundReason"],
      { field: "createdAt", order: "desc" }
    );
    const orderBy: Prisma.OrderOrderByWithRelationInput =
      orderSort.field === "customer"
        ? { customer: { name: orderSort.order } }
        : orderSort.field === "cashier"
          ? { user: { name: orderSort.order } }
          : orderSort.field === "refundedBy"
            ? { refundedBy: { name: orderSort.order } }
            : { [orderSort.field]: orderSort.order };

    const [orders, agg] = await Promise.all([
      db.order.findMany({
        where,
        include: {
          user: { select: { id: true, name: true } },
          refundedBy: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true } },
          items: { select: { quantity: true, unit: true, total: true, unitPrice: true, productName: true, sku: true } },
          payments: { select: { method: true, amount: true, status: true } },
        },
        orderBy,
        skip,
        take,
      }),
      db.order.aggregate({
        where,
        _count: { _all: true },
        _sum: { total: true },
      }),
    ]);

    const total = agg._count._all;
    const sumTotal = agg._sum.total ?? 0;

    // Enrich with item/line counts. When loose goods (0.385 kg sugar) are
    // involved, a summed quantity is meaningless, so callers show line count.
    const enriched = orders.map((o) => {
      const fractional = o.items.some((i) => !Number.isInteger(i.quantity));
      return {
        ...o,
        itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
        lineCount: o.items.length,
        fractional,
      };
    });

    return NextResponse.json({
      orders: enriched,
      total,
      sumTotal,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      hasNext: page * pageSize < total,
    });
  } catch (error) {
    console.error("[ORDERS_GET]", error);
    return apiError("Internal server error", 500);
  }
}
