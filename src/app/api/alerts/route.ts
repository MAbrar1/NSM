import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { scanLowStock, scanRestockSoon } from "@/lib/low-stock";
import type { StockAlert } from "@/lib/alert-utils";

/* ═══════════════════════════════════════════════════════════════
   ALERTS API
   GET /api/alerts — Returns low stock and out of stock alerts,
   enriched with product pricing/category for the notification bell
   and the dashboard Restock widget.
   Optional `?warehouseId=<id>` narrows alerts to one warehouse.
   Built on the shared low-stock scan engine (single classification
   source of truth with /api/notifications/low-stock).

   `inAppEnabled` mirrors StoreSettings.lowStockNotifyAdmins — the
   "In-App Notifications" switch in Settings. The dashboard widget is
   a data panel and always renders; the header bell is the in-app
   notification surface and goes quiet when the store turns it off,
   which is exactly what the setting promises. Emitting the flag lets
   the bell honour it without a second settings round-trip.

   `generatedAt` lets the bell show how fresh its feed is.
   ═══════════════════════════════════════════════════════════════ */

const EMPTY_SUMMARY = { total: 0, critical: 0, warning: 0, info: 0 };

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const candidates = await scanLowStock();
    // Optional per-warehouse scope (dashboard scope selector): the scan
    // runs unfiltered, then rows outside the scope are dropped.
    const warehouseId = request.nextUrl.searchParams.get("warehouseId");
    const scoped = warehouseId
      ? candidates.filter((c) => c.warehouseId === warehouseId)
      : candidates;

    // One settings read drives both the opt-in early-warning channel and the
    // in-app channel flag surfaced to the bell.
    const settings = await db.storeSettings.findUnique({
      where: { id: "singleton" },
      select: { lowStockRunningLowAlerts: true, lowStockNotifyAdmins: true },
    });
    const inAppEnabled = settings?.lowStockNotifyAdmins ?? true;

    // Opt-in early warnings are a SEPARATE list. They must not be merged into
    // `alerts`/`summary` or the low-stock count would grow for reasons no other
    // screen can see — which is exactly the bug this route used to have.
    const restockSoonRaw = settings?.lowStockRunningLowAlerts ? await scanRestockSoon() : [];
    const scopedRestockSoon = warehouseId
      ? restockSoonRaw.filter((c) => c.warehouseId === warehouseId)
      : restockSoonRaw;

    const generatedAt = new Date().toISOString();

    if (scoped.length === 0 && scopedRestockSoon.length === 0) {
      return NextResponse.json({
        alerts: [],
        summary: EMPTY_SUMMARY,
        restockSoon: [],
        restockSoonCount: 0,
        inAppEnabled,
        generatedAt,
      });
    }

    // Enrich with pricing + category in one query (the pieces the bell shows)
    const productIds = [...new Set([...scoped, ...scopedRestockSoon].map((c) => c.productId))];
    const products = await db.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        category: { select: { name: true } },
        unitPrice: true,
        costPrice: true,
        imageUrl: true,
        barcode: true,
        name: true,
        sku: true,
        minStockLevel: true,
        maxStockLevel: true,
      },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    // Each candidate row is one product×warehouse, matching the old shape.
    // `message` stays empty — clients render localized text via
    // alertMessage(alert, t) so no server-side language is baked in.
    const toAlerts = (list: typeof scoped): StockAlert[] =>
      list.map((c) => {
        const p = productById.get(c.productId);
        return {
          id: `${c.productId}:${c.warehouseId}`,
          severity: c.severity,
          kind: c.kind,
          message: "",
          remaining: c.currentStock,
          minStock: c.minStockLevel,
          currentStock: c.currentStock,
          productId: c.productId,
          productName: p?.name ?? c.productName,
          sku: p?.sku ?? c.sku,
          category: p?.category?.name ?? "",
          warehouseId: c.warehouseId,
          warehouseName: c.warehouseName,
          stockValue: c.currentStock * (p?.costPrice ?? 0),
          unitPrice: p?.unitPrice ?? 0,
        };
      });

    const alerts = toAlerts(scoped);
    const restockSoon = toAlerts(scopedRestockSoon);

    // `summary` describes the low-stock set ONLY — `restockSoonCount` is the
    // separate early-warning tally.
    const summary = {
      total: alerts.length,
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      info: alerts.filter((a) => a.severity === "info").length,
    };

    return NextResponse.json({
      alerts,
      summary,
      restockSoon,
      restockSoonCount: restockSoon.length,
      inAppEnabled,
      generatedAt,
    });
  } catch (error) {
    console.error("[ALERTS_GET]", error);
    return NextResponse.json(
      {
        alerts: [],
        summary: EMPTY_SUMMARY,
        restockSoon: [],
        restockSoonCount: 0,
        inAppEnabled: true,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
