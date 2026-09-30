import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import {
  scanLowStock,
  deliverLowStockAlerts,
  type StockAlertCandidate,
} from "@/lib/low-stock";

/* ═══════════════════════════════════════════════════════════════
   LOW-STOCK NOTIFICATION TRIGGER
   GET  /api/notifications/low-stock — Preview pending alerts
   POST /api/notifications/low-stock — Scan + send (throttled by the
   per-item cooldown, so repeated calls never spam the same item).
   ═══════════════════════════════════════════════════════════════ */

interface AlertView extends Omit<StockAlertCandidate, "minStockLevel"> {
  minStockLevel: number;
  timestamp: string;
}

function toView(c: StockAlertCandidate): AlertView {
  return { ...c, timestamp: new Date().toISOString() };
}

/** GET — Preview alerts without sending */
export async function GET() {
  try {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const candidates = await scanLowStock();
    const alerts = candidates.map(toView);

    return NextResponse.json({
      count: alerts.length,
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      info: alerts.filter((a) => a.severity === "info").length,
      alerts,
    });
  } catch (error) {
    console.error("[LOW_STOCK_PREVIEW]", error);
    return NextResponse.json({ count: 0, alerts: [] }, { status: 500 });
  }
}

/** POST — Scan and send notifications (cooldown-throttled per item) */
export async function POST() {
  try {
    const { response } = await requirePermission("inventory:adjust");
    if (response) return response;

    const candidates = await scanLowStock();
    const { sent, throttled, errors } = await deliverLowStockAlerts(candidates);

    return NextResponse.json({
      message: `Notifications sent for ${sent} low-stock item${sent === 1 ? "" : "s"}`,
      total: candidates.length,
      sent,
      throttled,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("[LOW_STOCK_NOTIFY]", error);
    return apiError("Internal server error", 500);
  }
}
