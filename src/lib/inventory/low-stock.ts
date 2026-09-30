/* ═══════════════════════════════════════════════════════════════
   LOW-STOCK ALERT ENGINE (shared)
   One classification + candidate scan used by /api/alerts, the
   /api/notifications/low-stock trigger and the scheduled notifier:

   1. classify(quantity, min) → severity + kind
      (out_of_stock → critical → below_min)
   2. scanLowStock() → all stock levels at/below their per-product
      minimum (or the configured hard floor), tagged + sorted.

   The ladder deliberately stops at the product's own minimum, which is
   exactly the rule lib/stock-status exposes to every screen. It used to
   carry a fourth "running_low" tier (below 30% of maxStockLevel, severity
   info) that nothing else shared — so the dashboard counted rows as low
   while Products/POS/Inventory called the same row OK. An alert now
   always means "low or out" everywhere.
   3. deliverLowStockAlerts() → send + record, throttled per
      (product, warehouse) via StockAlertLog so a row that stays low
      for days is only re-notified every `cooldownHours` (default 6).

   Pure classification is kept DB-free so it is unit-testable.
   ═══════════════════════════════════════════════════════════════ */

import { db } from "@/lib/db";
import { sellableUnits } from "@/lib/inventory/stock-status";
import { sendLowStockAlert, type LowStockAlertPayload } from "@/lib/notifications/notify";

export type AlertSeverity = "critical" | "warning" | "info";
/** `running_low` is retired (see classifyStock) but kept in the union for
 *  historical StockAlertLog rows and stored webhook payloads. */
export type AlertKind = "out_of_stock" | "critical" | "below_min" | "running_low";

export interface StockAlertCandidate {
  severity: AlertSeverity;
  kind: AlertKind;
  productId: string;
  productName: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  currentStock: number;
  minStockLevel: number;
}

/**
 * The opt-in "restock soon" band, kept separate from classifyStock so the
 * low-stock rule stays identical to stockStatus() everywhere. Pure.
 *   above the minimum, but at/under 30% of the product's max level.
 */
export function classifyRestockSoon(quantity: number, minLevel: number, maxLevel: number): boolean {
  return quantity > minLevel && quantity <= Math.floor(maxLevel * 0.3);
}

/** Classify one stock level. Pure — no I/O. `null` = no alert.
 *  (out_of_stock → critical → below_min, mirroring stockStatus: the only
 *  thing that counts as an alert is stock at/below the product's own
 *  minimum.) `maxLevel` is intentionally not consulted — see the note at
 *  the top of this file on the retired running_low tier. */
export function classifyStock(
  quantity: number,
  minLevel: number
): { severity: AlertSeverity; kind: AlertKind } | null {
  if (quantity <= 0) return { severity: "critical", kind: "out_of_stock" };
  if (quantity <= Math.floor(minLevel * 0.5)) return { severity: "critical", kind: "critical" };
  if (quantity <= minLevel) return { severity: "warning", kind: "below_min" };
  return null;
}

interface ScanOptions {
  /** Only return stock at/below this many units (instead of per-product min). */
  floor?: number | null;
}

/**
 * The stock rows both scanners classify: base rows (variants are tracked
 * separately — alerting the parent for a low variant would mislead restocking)
 * in active warehouses. Shared so the low and restock-soon scanners can never
 * disagree about which rows are in play.
 */
async function loadTrackedStockRows() {
  return db.stockLevel.findMany({
    where: {
      warehouse: { isActive: true },
      variantId: null,
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          status: true,
          deletedAt: true,
          trackInventory: true,
          minStockLevel: true,
          maxStockLevel: true,
          allowFractional: true,
        },
      },
      warehouse: { select: { id: true, name: true } },
    },
  });
}

type TrackedStockRow = Awaited<ReturnType<typeof loadTrackedStockRows>>[number];

/**
 * Shared prelude: skip rows whose product can't be restocked, and reduce
 * on-hand to the SELLABLE quantity every screen displays. Returns null when the
 * row is out of scope for alerting. `threshold` honours the optional global
 * floor override.
 */
function alertableRow(
  sl: TrackedStockRow,
  floor: number | null | undefined
): { sellable: number; threshold: number; maxLevel: number } | null {
  const p = sl.product;
  if (p.deletedAt || p.status !== "active" || !p.trackInventory) return null;

  const sellable = sellableUnits(
    sl.quantity - (Number.isFinite(sl.reservedQuantity) ? sl.reservedQuantity : 0),
    p.allowFractional
  );
  const threshold = floor != null ? floor : p.minStockLevel;
  return { sellable, threshold, maxLevel: p.maxStockLevel ?? Math.max(p.minStockLevel * 3, 1) };
}

/**
 * Load every active, inventory-tracked product's stock and return the
 * rows that are at or below their threshold. Sorted critical-first.
 */
export async function scanLowStock(options: ScanOptions = {}): Promise<StockAlertCandidate[]> {
  const stockLevels = await loadTrackedStockRows();
  const candidates: StockAlertCandidate[] = [];

  for (const sl of stockLevels) {
    const row = alertableRow(sl, options.floor);
    if (!row) continue;

    const classified = classifyStock(row.sellable, row.threshold);
    if (!classified) continue;
    const { severity, kind } = classified;

    candidates.push({
      severity,
      kind,
      productId: sl.product.id,
      productName: sl.product.name,
      sku: sl.product.sku,
      warehouseId: sl.warehouse.id,
      warehouseName: sl.warehouse.name,
      currentStock: row.sellable,
      minStockLevel: row.threshold,
    });
  }

  const order: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  candidates.sort((a, b) => order[a.severity] - order[b.severity]);
  return candidates;
}

/**
 * The OPT-IN early-warning band: stock above the product's minimum but at or
 * under 30% of its maximum. This is the tier `classifyStock` deliberately does
 * not emit, exposed as its own channel so switching it on cannot move the
 * low-stock numbers anywhere in the app.
 *
 * Note it only ever fires for products with an explicit `maxStockLevel` well
 * above their minimum: with the implicit default (max = min × 3) the band is
 * 30% of 3×min = 0.9×min, which is below the minimum itself, so the result is
 * empty. That is intentional — "restock soon" is only meaningful once a store
 * has told us what "full" looks like.
 */
export async function scanRestockSoon(options: ScanOptions = {}): Promise<StockAlertCandidate[]> {
  const stockLevels = await loadTrackedStockRows();
  const candidates: StockAlertCandidate[] = [];

  for (const sl of stockLevels) {
    const row = alertableRow(sl, options.floor);
    if (!row) continue;
    if (!classifyRestockSoon(row.sellable, row.threshold, row.maxLevel)) continue;

    candidates.push({
      severity: "info",
      kind: "running_low",
      productId: sl.product.id,
      productName: sl.product.name,
      sku: sl.product.sku,
      warehouseId: sl.warehouse.id,
      warehouseName: sl.warehouse.name,
      currentStock: row.sellable,
      minStockLevel: row.threshold,
    });
  }

  // Closest to running out first.
  candidates.sort((a, b) => a.currentStock - b.currentStock);
  return candidates;
}

/** Cooldown (hours) between re-notifications of the same item. */
export const DEFAULT_COOLDOWN_HOURS = 6;

/**
 * Send notifications for every candidate whose cooldown has elapsed,
 * recording each send in StockAlertLog. Safe to run on every stock
 * change: rows under threshold with a recent alert are skipped, so the
 * cost is one indexed lookup per candidate.
 *
 * Returns what was delivered and what was skipped (throttled).
 */
export async function deliverLowStockAlerts(
  candidates: StockAlertCandidate[]
): Promise<{ sent: number; throttled: number; errors: string[] }> {
  if (candidates.length === 0) return { sent: 0, throttled: 0, errors: [] };

  const settings = await db.storeSettings.findUnique({ where: { id: "singleton" } });
  const cooldownMs =
    (settings?.lowStockCooldownHours != null ? settings.lowStockCooldownHours : DEFAULT_COOLDOWN_HOURS) *
    60 *
    60 *
    1000;

  const now = new Date();
  let sent = 0;
  let throttled = 0;
  const errors: string[] = [];

  for (const c of candidates) {
    const last = await db.stockAlertLog.findUnique({
      where: {
        productId_warehouseId: { productId: c.productId, warehouseId: c.warehouseId },
      },
      select: { lastAlertedAt: true },
    });

    // Skip when the same item was notified within the cooldown window.
    if (last && now.getTime() - last.lastAlertedAt.getTime() < cooldownMs) {
      throttled++;
      continue;
    }

    const payload: LowStockAlertPayload = {
      productId: c.productId,
      productName: c.productName,
      sku: c.sku,
      warehouseId: c.warehouseId,
      warehouseName: c.warehouseName,
      currentStock: c.currentStock,
      minStockLevel: c.minStockLevel,
      severity: c.severity,
      kind: c.kind,
      timestamp: now.toISOString(),
    };

    try {
      // Record BEFORE delivering (fire-and-forget delivery below). If the
      // channel is down we still respect the cooldown and re-try on the
      // next cycle rather than stampeding every scan.
      await db.stockAlertLog.upsert({
        where: {
          productId_warehouseId: { productId: c.productId, warehouseId: c.warehouseId },
        },
        update: {
          lastAlertedAt: now,
          lastQuantity: c.currentStock,
          lastSeverity: c.severity,
          lastKind: c.kind,
          attempts: { increment: 1 },
        },
        create: {
          productId: c.productId,
          warehouseId: c.warehouseId,
          lastAlertedAt: now,
          lastQuantity: c.currentStock,
          lastSeverity: c.severity,
          lastKind: c.kind,
          attempts: 1,
        },
      });
      await sendLowStockAlert(payload);
      sent++;
    } catch (err) {
      errors.push(`${c.productName}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return { sent, throttled, errors };
}

/** Full scan + delivery, used by the cron/notifier endpoint. */
export async function runLowStockNotifier(): Promise<{
  scanned: number;
  sent: number;
  throttled: number;
  errors: string[];
}> {
  const settings = await db.storeSettings.findUnique({ where: { id: "singleton" } });
  const enabled = settings?.lowStockSchedulerEnabled ?? true;
  if (!enabled) {
    return { scanned: 0, sent: 0, throttled: 0, errors: ["Scheduler disabled in settings"] };
  }

  // Opt-in: restock-soon rows ride the same delivery + cooldown path, so they
  // reach webhook/email subscribers without ever touching the low-stock counts.
  const floor = settings?.lowStockMinQuantity ?? null;
  const candidates = await scanLowStock({ floor });
  if (settings?.lowStockRunningLowAlerts) {
    candidates.push(...(await scanRestockSoon({ floor })));
  }
  const result = await deliverLowStockAlerts(candidates);
  return { scanned: candidates.length, ...result };
}
