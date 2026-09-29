import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";

/* ═══════════════════════════════════════════════════════════════
   ALERT DELIVERY LOG
   GET /api/notifications/log — Recent low-stock notification sends
   for the settings/admin "Delivery log" view.

   StockAlertLog keeps ONE row per (product, warehouse): the last time
   the throttled notifier actually went out for that item, the quantity
   and severity at that moment, and how many times it has fired. That
   is what this route returns, enriched with the product and warehouse
   names a human needs, plus the channel configuration that produced it
   — so the log is never read without the context that explains it.

   `?limit=` is clamped to [1, 100] (default 25).
   ═══════════════════════════════════════════════════════════════ */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("inventory:view");
    if (response) return response;

    const rawLimit = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
      : DEFAULT_LIMIT;

    const [logs, settings] = await Promise.all([
      db.stockAlertLog.findMany({
        orderBy: { lastAlertedAt: "desc" },
        take: limit,
      }),
      db.storeSettings.findUnique({
        where: { id: "singleton" },
        select: {
          lowStockNotifyWebhook: true,
          lowStockNotifyEmail: true,
          lowStockNotifyAdmins: true,
          lowStockCooldownHours: true,
        },
      }),
    ]);

    const productIds = [...new Set(logs.map((l) => l.productId))];
    const warehouseIds = [...new Set(logs.map((l) => l.warehouseId))];
    const [products, warehouses] = await Promise.all([
      db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, sku: true },
      }),
      db.warehouse.findMany({
        where: { id: { in: warehouseIds } },
        select: { id: true, name: true },
      }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const warehouseById = new Map(warehouses.map((w) => [w.id, w]));

    return NextResponse.json({
      log: logs.map((l) => ({
        id: l.id,
        productId: l.productId,
        // Null name means the product was removed since — the row is still
        // shown so the history is not silently truncated.
        productName: productById.get(l.productId)?.name ?? null,
        sku: productById.get(l.productId)?.sku ?? null,
        warehouseId: l.warehouseId,
        warehouseName: warehouseById.get(l.warehouseId)?.name ?? null,
        lastAlertedAt: l.lastAlertedAt,
        lastQuantity: l.lastQuantity,
        severity: l.lastSeverity,
        kind: l.lastKind,
        attempts: l.attempts,
      })),
      channels: {
        webhook: settings?.lowStockNotifyWebhook ?? false,
        email: settings?.lowStockNotifyEmail ?? false,
        inApp: settings?.lowStockNotifyAdmins ?? true,
      },
      cooldownHours: settings?.lowStockCooldownHours ?? 6,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NOTIF_LOG]", error);
    return NextResponse.json({ log: [], channels: null, cooldownHours: null }, { status: 500 });
  }
}
