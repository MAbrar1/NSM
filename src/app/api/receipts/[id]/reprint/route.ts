import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import { db } from "@/lib/db";
import {
  canReprint,
  resolvePrintAction,
  reprintCount,
  writePrintLog,
  verifyBeforeReprint,
} from "@/lib/receipt-print";

/* ═══════════════════════════════════════════════════════════════
   RECEIPT REPRINT API
   POST /api/receipts/[id]/reprint  { reason, printerProfileId? }
   - Permission: manager+ any receipt; cashier own within window.
   - Verifies content_hash BEFORE rendering (mismatch → 409 + audit).
   - Resolves PRINT (retry of failed first) vs REPRINT from the log.
   - ALWAYS writes a ReceiptPrintLog row (success or failure) with
     the required reason. Rendering/delivery is client-side via the
     PrintService; the client reports the delivery result here so
     the log reflects reality.
   ═══════════════════════════════════════════════════════════════ */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { user, response } = await requirePermission("orders:view");
    if (response) return response;

    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string; printerProfileId?: string; result?: "OK" | "FAILED"; errorCode?: string };
    const reason = (body.reason ?? "").trim();
    if (!reason) {
      return fieldError({ reason: ["A reason is required to reprint a receipt"] });
    }

    const receipt = await db.receipt.findUnique({ where: { id } });
    if (!receipt) return apiError("Receipt not found", 404);

    // Order → issuing cashier for the own-receipt window rule.
    const order = await db.order.findUnique({
      where: { id: receipt.orderId },
      select: { userId: true },
    });
    if (!order) return apiError("Order for receipt not found", 404);

    const decision = canReprint(
      { userId: user.id, role: user.role },
      { userId: order.userId, issuedAt: receipt.issuedAt, status: receipt.status }
    );
    if (!decision.allowed) {
      return apiError(decision.reason, 403);
    }

    // Hash gate: history renders only when untampered.
    const verified = await verifyBeforeReprint(
      {
        id: receipt.id,
        receiptNo: receipt.receiptNo,
        snapshotJson: receipt.snapshotJson,
        templateVersion: receipt.templateVersion,
        contentHash: receipt.contentHash,
      },
      { userId: user.id, role: user.role }
    );
    if (!verified.ok || !verified.snapshot) {
      return apiError("Receipt content hash mismatch — reprint blocked and audited", 409);
    }

    const action = await resolvePrintAction(receipt.id);
    const duplicates = await reprintCount(receipt.id);

    // Log the attempt up front with the client-reported delivery
    // result when present; otherwise record the intent as FAILED
    // only when the client reports failure on the follow-up call.
    const result = body.result === "OK" ? "OK" : body.result === "FAILED" ? "FAILED" : "OK";
    await writePrintLog({
      receiptId: receipt.id,
      action,
      result,
      errorCode: body.errorCode ?? null,
      userId: user.id,
      printerProfileId: body.printerProfileId ?? null,
      terminalId: receipt.terminalId,
      reason,
    });

    return NextResponse.json({
      action,
      duplicates: result === "OK" ? duplicates + 1 : duplicates,
      snapshot: verified.snapshot,
      templateVersion: receipt.templateVersion,
      fiscal: await db.receiptFiscalRecord.findUnique({ where: { receiptId: receipt.id } }),
    });
  } catch (error) {
    console.error("[RECEIPT_REPRINT]", error);
    return apiError("Internal server error", 500);
  }
}
