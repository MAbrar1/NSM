/* ═══════════════════════════════════════════════════════════════
   ALERT TEXT + FEED HELPERS — localized, structured stock alerts
   /api/alerts returns `kind` + numeric fields so the client can build
   a proper localized message instead of showing the server's English
   string. Shared by the header notification bell and the dashboard
   low-stock widget.

   The pure helpers here (sorting, severities, defensive parsing,
   unseen counting) carry no JSX and no browser API, so they are
   unit-testable and can run on both surfaces.
   ═══════════════════════════════════════════════════════════════ */

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertKind = "out_of_stock" | "critical" | "below_min" | "running_low";

export interface StockAlert {
  id: string;
  severity: AlertSeverity;
  kind: AlertKind;
  message: string; // English fallback (kept for non-i18n consumers)
  remaining: number;
  minStock: number;
  currentStock: number;
  productId: string;
  productName: string;
  sku: string;
  category: string;
  warehouseId: string;
  warehouseName: string;
  stockValue: number;
  unitPrice: number;
}

export interface AlertSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
}

/** Wire shape of GET /api/alerts. */
export interface AlertFeed {
  alerts: StockAlert[];
  /** Opt-in early warnings — a separate channel that never moves the counts. */
  restockSoon: StockAlert[];
  summary: AlertSummary;
  restockSoonCount: number;
  /** Mirrors StoreSettings.lowStockNotifyAdmins (the in-app channel switch). */
  inAppEnabled: boolean;
  /** ISO timestamp of the scan that produced this feed. */
  generatedAt: string;
}

export const EMPTY_ALERT_SUMMARY: AlertSummary = { total: 0, critical: 0, warning: 0, info: 0 };

export const EMPTY_ALERT_FEED: AlertFeed = {
  alerts: [],
  restockSoon: [],
  summary: EMPTY_ALERT_SUMMARY,
  restockSoonCount: 0,
  inAppEnabled: true,
  generatedAt: "",
};

/** Critical first, then warning, then info. Stable within a severity. */
export const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function severityRank(severity: AlertSeverity): number {
  return SEVERITY_ORDER[severity] ?? SEVERITY_ORDER.info;
}

/** Order a copy of the list critical-first (never mutates the input). */
export function sortAlertsBySeverity(list: StockAlert[]): StockAlert[] {
  return [...list].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** The worst severity present, or null for an empty set. */
export function worstSeverity(list: StockAlert[]): AlertSeverity | null {
  let worst: AlertSeverity | null = null;
  for (const a of list) {
    if (worst === null || severityRank(a.severity) < severityRank(worst)) worst = a.severity;
  }
  return worst;
}

/**
 * Defensive parse of the /api/alerts payload. A malformed or hostile
 * response degrades to an empty feed instead of throwing inside render
 * (a server blip must never surface as "all stocked" — the hook keeps
 * a distinct error state for that).
 */
export function parseAlertFeed(raw: unknown): AlertFeed {
  const data = (raw ?? {}) as Partial<AlertFeed> & {
    alerts?: unknown;
    restockSoon?: unknown;
    summary?: unknown;
  };
  const alerts = Array.isArray(data.alerts) ? (data.alerts as StockAlert[]) : [];
  const restockSoon = Array.isArray(data.restockSoon) ? (data.restockSoon as StockAlert[]) : [];
  const summary = data.summary as Partial<AlertSummary> | undefined;
  return {
    alerts,
    restockSoon,
    summary: {
      total: numeric(summary?.total, alerts.length),
      critical: numeric(summary?.critical, alerts.filter((a) => a.severity === "critical").length),
      warning: numeric(summary?.warning, alerts.filter((a) => a.severity === "warning").length),
      info: numeric(summary?.info, alerts.filter((a) => a.severity === "info").length),
    },
    restockSoonCount: numeric(data.restockSoonCount, restockSoon.length),
    inAppEnabled: data.inAppEnabled !== false,
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
  };
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Every id in the feed (low + restock-soon), for read/unread tracking. */
export function feedAlertIds(feed: Pick<AlertFeed, "alerts" | "restockSoon">): string[] {
  return [...feed.alerts, ...feed.restockSoon].map((a) => a.id);
}

/** Count feed items the user has not acknowledged yet. */
export function countUnseen(
  feed: Pick<AlertFeed, "alerts" | "restockSoon">,
  seen: ReadonlySet<string>
): number {
  let count = 0;
  for (const id of feedAlertIds(feed)) if (!seen.has(id)) count++;
  return count;
}

/** Shape of a delivery-log row, shared by the settings log reader. */
export interface DeliveryEntry {
  id: string;
  productId: string;
  productName: string | null;
  sku: string | null;
  warehouseId: string;
  warehouseName: string | null;
  lastAlertedAt: string;
  lastQuantity: number;
  severity: string | null;
  kind: string | null;
  attempts: number;
}

/** Map a delivery-log row into a StockAlert-shaped object so the shared
 *  AlertTileInline can render it with the same recipe as the bell and the
 *  dashboard widget (one dot, one message, one stock chip). */
/**
 * Localized LABEL for an alert kind (no numbers). Used where a row already
 * states the quantity separately — e.g. the delivery log — so the same kind
 * never gets two different names across surfaces.
 */
export function alertKindLabel(kind: AlertKind | string | null, t: Translate): string {
  switch (kind) {
    case "out_of_stock":
      return t("alerts.outOfStock");
    case "critical":
      return t("alerts.criticallyLow");
    case "below_min":
      return t("alerts.belowMin");
    case "running_low":
      return t("alerts.runningLow");
    default:
      return t("dashboard.warning");
  }
}

export function alertMessage(alert: StockAlert, t: Translate): string {
  const min = t("alerts.min");
  const remaining = t("alerts.remaining");
  switch (alert.kind) {
    case "out_of_stock":
      return t("alerts.outOfStock");
    case "critical":
      return `${t("alerts.criticallyLow")} — ${alert.remaining} ${remaining} (${min}: ${alert.minStock})`;
    case "below_min":
      return `${t("alerts.belowMin")} — ${alert.remaining} ${remaining} (${min}: ${alert.minStock})`;
    case "running_low":
      return `${t("alerts.runningLow")} — ${alert.remaining} ${remaining}`;
    default:
      return alert.message;
  }
}

/**
 * Map a delivery-log row into a StockAlert-shaped object so the shared
 *  AlertTileInline can render it with the same recipe as the bell and the
 *  dashboard widget (one dot, one message, one stock chip).
 */
type Translate = (key: string) => string;

export interface DeliveryEntry {
  id: string;
  productId: string;
  productName: string | null;
  sku: string | null;
  warehouseId: string;
  warehouseName: string | null;
  lastAlertedAt: string;
  lastQuantity: number;
  severity: string | null;
  kind: string | null;
  attempts: number;
}

export function auditAlertForEntry(
  entry: DeliveryEntry,
  severity: string,
): StockAlert {
  return {
    id: entry.id,
    severity: severity as AlertSeverity,
    kind: (entry.kind ?? "info") as AlertKind,
    message: "",
    remaining: entry.lastQuantity,
    minStock: 0,
    currentStock: entry.lastQuantity,
    productId: entry.productId,
    productName: entry.productName ?? "",
    sku: entry.sku ?? "",
    category: "",
    warehouseId: entry.warehouseId,
    warehouseName: entry.warehouseName ?? "",
    stockValue: 0,
    unitPrice: 0,
  };
}

