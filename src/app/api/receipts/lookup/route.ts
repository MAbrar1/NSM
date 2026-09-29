import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { requirePermission } from "@/lib/api-auth";
import { db } from "@/lib/db";

/* ═══════════════════════════════════════════════════════════════
   RECEIPT LOOKUP API
   GET /api/receipts/lookup?receiptNo=R-T1-000042
   GET /api/receipts/lookup?from=…&to=…&customerId=…&userId=…&mine=1
   Serves Sales History, customer history and Returns-by-receipt
   flows. Requires orders:view (cashier+). Receipt numbers are
   matched exactly; history filters are conjunctive.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("orders:view");
    if (response) return response;

    const params = request.nextUrl.searchParams;
    const receiptNo = params.get("receiptNo")?.trim();
    const from = params.get("from");
    const to = params.get("to");
    const customerId = params.get("customerId");
    const userId = params.get("userId");
    const mine = params.get("mine") === "1";
    const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? 25)));

    if (receiptNo) {
      const receipt = await db.receipt.findUnique({
        where: { receiptNo },
        include: {
          fiscalRecord: true,
          printLogs: { orderBy: { createdAt: "desc" }, take: 5 },
          order: {
            select: {
              id: true, orderNumber: true, total: true, status: true,
              refundedAmount: true, customerId: true, customer: { select: { name: true } },
            },
          },
        },
      });
      if (!receipt) return apiError("Receipt not found", 404);
      return NextResponse.json({ receipt });
    }

    const where = {
      ...(from || to
        ? { issuedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } }
        : {}),
      ...(customerId ? { order: { customerId } } : {}),
      ...(mine ? { order: { userId: user.id } } : userId ? { order: { userId } } : {}),
    };

    const receipts = await db.receipt.findMany({
      where,
      orderBy: { issuedAt: "desc" },
      take: limit,
      include: {
        fiscalRecord: { select: { invoiceNo: true } },
        order: {
          select: {
            orderNumber: true, total: true, status: true,
            customer: { select: { name: true } },
            user: { select: { name: true } },
          },
        },
      },
    });

    return NextResponse.json({ receipts });
  } catch (error) {
    console.error("[RECEIPT_LOOKUP]", error);
    return apiError("Internal server error", 500);
  }
}
