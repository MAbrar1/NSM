"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/providers/i18n-provider";
import { useStoreCurrency } from "@/components/providers/currency-provider";
import { useWarehouseStore } from "@/stores/warehouse-store";
import { useDashboardPrefsStore, commitDashboardPrefs } from "@/stores/settings-store";
import { formatCurrency, cn, percentDelta, getInitials } from "@/lib/utils";
import { BarChart, DonutChart, monthRange } from "@/components/ui/chart";
import {
  StatCard,
  StatIcon,
  type StatBarSegment,
  type StatIconName,
  type StatTone,
} from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TotalProductsCard } from "@/components/ui/total-products-card";
import { EMPTY_ALERT_SUMMARY, auditAlertForEntry } from "@/lib/alert-utils";
import { AlertTileInline } from "@/components/ui/alert-tile";
import { useAlerts } from "@/hooks/use-alerts";
import { canAccessRoute, type Role } from "@/lib/rbac";

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD PAGE
   Real-time store overview: revenue vs. yesterday / last month,
   a 7-day revenue trend, today's hourly sales, recent orders,
   top sellers, and severity-sorted low-stock alerts (localized).
   Quick actions adapt to the signed-in role's permissions.
   ═══════════════════════════════════════════════════════════════ */

interface DashboardData {
  /** Headline: revenue over the selected range. */
  rangeRevenue: number;
  rangeOrders: number;
  /** Equal-length window immediately before the range (delta base). */
  prevRangeRevenue: number;
  prevRangeOrders: number;
  /** Month-to-date totals (secondary KPI). */
  monthRevenue: number;
  monthOrders: number;
  prevMonthRevenue: number;
  totalProducts: number;
  /** Distinct products needing restock — comparable with `totalProducts`. */
  lowStockCount: number;
  /** Of `lowStockCount`: products with zero sellable units somewhere. */
  lowStockOutCount?: number;
  /** Of `lowStockCount`: products low but not out anywhere. */
  lowStockLowCount?: number;
  /** Cents of open credit (khata) dues across all customers. */
  outstandingDues?: number;
  /** Count of orders carrying an open due. */
  outstandingDuesOrders?: number;
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    total: number;
    status: string;
    createdAt: string;
    user: { name: string };
    customer?: { name: string } | null;
  }>;
  topProducts: Array<{
    name: string;
    totalSold: number;
    revenue: number;
  }>;
  weekTrend: Array<{ date: string; revenue: number; orders: number }>;
  todayHourly: Array<{ hour: number; revenue: number; orders: number }>;
  weekHourly: Array<{ date: string; hour: number; revenue: number; orders: number }>;
  refundTrend: Array<{ month: string; count: number; total: number }>;
  refundReasons: Array<{ reason: string | null; count: number; total: number }>;
  topCustomers: Array<{ name: string; revenue: number; orders: number }>;
  orderStatusBreakdown: Array<{ status: string; count: number; total: number }>;
  /** Granularity of `weekTrend` — "day" for ≤7-day ranges, "month" beyond. */
  trendPeriod?: "day" | "month";
  /** Echo of the effective range (inclusive local dates). */
  rangeMeta?: { from: string; to: string; days: number; granularity: "daily" | "monthly" };
  /** Per-warehouse revenue/orders over the range (zero-filled). */
  warehouseComparison?: Array<{ warehouseId: string; name: string; revenue: number; orders: number }>;
}

function timeAgo(iso: string, t: (key: string) => string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return t("dashboard.justNow");
  if (mins < 60) return `${mins} ${t("dashboard.minAgo")}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? t("dashboard.hrAgo") : t("dashboard.hrsAgo")}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? t("dashboard.dayAgo") : t("dashboard.daysAgo")}`;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

const STATUS_VARIANT: Record<string, "success" | "info" | "warning" | "danger" | "default"> = {
  completed: "success",
  confirmed: "info",
  processing: "warning",
  pending: "warning",
  cancelled: "danger",
  refunded: "danger",
};

/* Activity-feed icon + tone per audit action. */
const ACTIVITY_STYLES: Record<string, { bg: string; icon: string }> = {
  checkout: { bg: "bg-neu-wash-green text-neu-ink-green", icon: "M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" },
  refund: { bg: "bg-neu-wash-red text-neu-ink-red", icon: "M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" },
  stock_adjust: { bg: "bg-neu-wash-amber text-neu-ink-amber", icon: "M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M12 9v4.375" },
  stock_transfer: { bg: "bg-neu-wash-cyan text-neu-ink-cyan", icon: "M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" },
  customer_payment: { bg: "bg-neu-accent-wash text-neu-accent-ink-strong", icon: "M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  create: { bg: "bg-neu-accent-wash text-neu-accent-ink-strong", icon: "M12 4.5v15m7.5-7.5h-15" },
  update: { bg: "bg-neu-sunken text-neu-muted", icon: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" },
  delete: { bg: "bg-neu-wash-red text-neu-ink-red", icon: "M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" },
};

/* Audit action → localized sentence template (dashboard.activity.*).
   Templates are grammar-aware per locale (e.g. Urdu ergative "نے … کیا")
   and carry {user}/{entity}/{action} placeholders. */
const ACTIVITY_TEMPLATE_KEYS: Record<string, string> = {
  checkout: "dashboard.activity.checkout",
  refund: "dashboard.activity.refund",
  stock_adjust: "dashboard.activity.stock_adjust",
  stock_transfer: "dashboard.activity.stock_transfer",
  customer_payment: "dashboard.activity.customer_payment",
  create: "dashboard.activity.create",
  update: "dashboard.activity.update",
  delete: "dashboard.activity.delete",
};

function activityTemplate(t: (key: string) => string, action: string): string {
  const key = ACTIVITY_TEMPLATE_KEYS[action];
  if (!key) return t("dashboard.activity.fallback");
  const resolved = t(key);
  // t() echoes the key when a translation is missing → use the fallback.
  return resolved === key ? t("dashboard.activity.fallback") : resolved;
}

/** Renders a localized activity sentence, highlighting user & entity. */
function ActivitySentence({
  template,
  user,
  entity,
  action,
}: {
  template: string;
  user: string;
  entity: string;
  action?: string;
}) {
  const nodes: React.ReactNode[] = [];
  const re = /\{(user|entity|action)\}/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) nodes.push(template.slice(last, m.index));
    const token = m[1] as "user" | "entity" | "action";
    const value = token === "user" ? user : token === "entity" ? entity : (action ?? "");
    nodes.push(
      <span
        key={key++}
        className={
          token === "user"
            ? "font-semibold text-neu-primary"
            : token === "entity"
              ? "font-medium"
              : undefined
        }
      >
        {value}
      </span>
    );
    last = re.lastIndex;
  }
  if (last < template.length) nodes.push(template.slice(last));
  return <>{nodes}</>;
}

/** One tile in the dashboard KPI grid. Every slot is a plain StatCard config
    except `products`, which the shared <TotalProductsCard> renders itself — so
    its wording lives in one place instead of being re-declared per page. */
type DashboardStatEntry =
  | {
      key: string;
      label: string;
      value: string;
      icon: StatIconName;
      tone: StatTone;
      delta?: number | null;
      deltaLabel?: string;
      sub?: string;
      bar?: StatBarSegment[];
      barLabel?: string;
      numericValue?: number;
      formatValue?: (v: number) => string;
    }
  | { key: "products" };

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { data: session } = useSession();
  // Subscribe to the display currency so KPI amounts re-format the
  // moment the store currency syncs (formatCurrency reads the
  // module-level default at call time).
  useStoreCurrency();
  const role = session?.user?.role as Role | undefined;
  const userId = session?.user?.id ?? null;
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);

  // Dashboard view prefs — date-range preset + warehouse scope. Both
  // are per-user (persisted to localStorage per signed-in user) and
  // changing either re-fetches with ?from/?to/?warehouseId so every
  // widget (KPIs, charts, heatmap, lists) reflects the selection.
  const rangePreset = useDashboardPrefsStore((s) => s.rangePreset);
  const warehouseScope = useDashboardPrefsStore((s) => s.warehouseScope);
  const setRangePreset = useDashboardPrefsStore((s) => s.setRangePreset);
  const setWarehouseScope = useDashboardPrefsStore((s) => s.setWarehouseScope);
  const hydrateDashboardPrefs = useDashboardPrefsStore((s) => s.hydrateDashboardPrefs);
  const commitDashboardPrefsForUser = commitDashboardPrefs;
  const { warehouses } = useWarehouseStore();

  // Shared stock-alert feed — the SAME hook the header bell uses, scoped to
  // this page's data-scope selection. Previously the dashboard ran its own
  // copy of the fetch, which is exactly how the two surfaces could disagree.
  const {
    feed: alertsFeed,
    status: alertsStatus,
    error: alertsError,
    refresh: refreshAlerts,
  } = useAlerts({ warehouseId: warehouseScope });

  // Derived views of the feed. `restockSoon` is the opt-in early-warning
  // channel — a SEPARATE list that never touches the low-stock counts.
  const alerts = alertsFeed?.alerts ?? [];
  const restockSoon = alertsFeed?.restockSoon ?? [];
  const alertSummary = alertsFeed?.summary ?? EMPTY_ALERT_SUMMARY;

  // Restore this user's saved prefs on sign-in (per-user localStorage).
  React.useEffect(() => {
    if (userId) hydrateDashboardPrefs(userId);
  }, [userId, hydrateDashboardPrefs]);

  // Commit scope/range changes to the user's persisted bucket. The ref
  // skips the commit triggered by hydration itself so saved prefs are
  // never clobbered by the just-restored defaults mid-hydration.
  const hydratedUserRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!userId) return;
    if (hydratedUserRef.current !== userId) {
      hydratedUserRef.current = userId;
      return;
    }
    commitDashboardPrefsForUser(userId, { rangePreset, warehouseScope });
  }, [userId, rangePreset, warehouseScope, commitDashboardPrefsForUser]);

  // ─── Date-range window (server-aligned with /api/dashboard) ───
  // `from`/`to` are local midnight dates, `to` inclusive, matching the
  // API's parsing so the UI label always describes the fetched data.
  const range = React.useMemo(() => {
    const day = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (rangePreset) {
      case "7d": {
        const from = new Date(today.getTime() - 6 * 86400000);
        return { from: day(from), to: day(today) };
      }
      case "30d": {
        const from = new Date(today.getTime() - 29 * 86400000);
        return { from: day(from), to: day(today) };
      }
      case "mtd":
        return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(today) };
      default:
        return { from: day(today), to: day(today) };
    }
  }, [rangePreset]);

  // Live activity feed (audit trail, latest first).
  interface ActivityEvent {
    id: string;
    action: string;
    entity: string;
    entityName: string;
    entityId: string;
    createdAt: string;
    user?: { name: string } | null;
  }
  const [activity, setActivity] = React.useState<ActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = React.useState(true);

  // Load (and later auto-refresh) the dashboard KPIs every 60s.
  // Skips silently when the tab is hidden; refreshes on return. The alert
  // feed has its own cadence in useAlerts.
  const loadData = React.useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    setRefreshing(true);
    try {
      // Scope + date-range for the KPI query (the alert feed scopes itself).
      const qs = new URLSearchParams();
      if (warehouseScope) qs.set("warehouseId", warehouseScope);
      qs.set("from", range.from);
      qs.set("to", range.to);
      const dashRes = await fetch(`/api/dashboard?${qs.toString()}`);
      // A 500 used to render as all-zero KPIs that looked like real data.
      if (!dashRes.ok) throw new Error(`Dashboard fetch failed (${dashRes.status})`);
      setData(await dashRes.json());
      setUpdatedAt(new Date());
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [warehouseScope, range]);

  React.useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60_000);
    const onVisibility = () => {
      if (!document.hidden) loadData();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadData]);

  // Fetch the activity feed alongside the dashboard (same cadence).
  const loadActivity = React.useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const res = await fetch("/api/activity?limit=12");
      if (!res.ok) return;
      const d = await res.json();
      setActivity(d.events ?? []);
    } catch {
      /* feed is supplementary */
    } finally {
      setActivityLoading(false);
    }
    // The activity feed is global (audit trail), not warehouse-scoped, so it
    // does not belong to the scope dependency — which was a dead re-subscribe.
  }, []);

  React.useEffect(() => {
    loadActivity();
    const interval = setInterval(loadActivity, 60_000);
    return () => clearInterval(interval);
  }, [loadActivity]);

  const weekTrendData = (data?.weekTrend ?? []).map((d) => ({
    label:
      data?.trendPeriod === "month"
        ? new Date(`${d.date}T00:00:00`).toLocaleDateString(locale === "ur" ? "ur-PK" : "en-US", {
            month: "short",
            year: "2-digit",
          })
        : new Date(`${d.date}T00:00:00`).toLocaleDateString(locale === "ur" ? "ur-PK" : "en-US", {
            weekday: "short",
          }),
    value: d.revenue,
  }));

  const hourlyData = (data?.todayHourly ?? []).map((h) => ({
    label: hourLabel(h.hour),
    value: h.revenue,
  }));

  // Refund trend — refunded value per month over the last 6 calendar months
  const refundTrendData = (data?.refundTrend ?? []).map((r) => {
    const [y, m] = r.month.split("-").map(Number);
    return {
      label: new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString(locale === "ur" ? "ur-PK" : "en-US", {
        month: "short",
        year: "2-digit",
      }),
      value: r.total,
      count: r.count,
      month: r.month,
    };
  });
  const refundTrendTotal = (data?.refundTrend ?? []).reduce((s, r) => s + r.total, 0);
  const refundTrendCount = (data?.refundTrend ?? []).reduce((s, r) => s + r.count, 0);
  const hasRefundData = refundTrendData.some((d) => d.value > 0);

  // Top refund reasons — proportion bars sized against the largest reason
  const refundReasons = data?.refundReasons ?? [];
  const maxReasonTotal = Math.max(1, ...refundReasons.map((r) => r.total));
  const hasReasonData = refundReasons.length > 0 && refundReasons.some((r) => r.total > 0);

  const todayDelta = data ? percentDelta(data.rangeRevenue, data.prevRangeRevenue) : null;
  const monthDelta = data ? percentDelta(data.monthRevenue, data.prevMonthRevenue) : null;

  // Low-stock card. The headline is DISTINCT products (`lowStockCount`), the
  // same unit as Total Products, so the two cards are finally comparable. The
  // sub-caption carries the location-level alert count the widget below lists
  // — one alert per product×warehouse — which used to be shown AS the product
  // count and could therefore exceed the whole catalog.
  const lowStockProducts = data?.lowStockCount ?? 0;
  const alertLocations = new Set(alerts.map((a) => a.warehouseId)).size;
  // Out/low composition of the card's number. "Low Stock" here means the
  // restock worklist (low + out), because a single-number card sits next to a
  // single-number alert list; the bar + tooltip expose the split the Inventory
  // page shows as two separate KPIs, so 58 vs 82 is auditable at a glance.
  const lowStockOut = data?.lowStockOutCount ?? 0;
  const lowStockLow = data?.lowStockLowCount ?? 0;
  const lowStockBar: StatBarSegment[] = lowStockProducts > 0
    ? [
        lowStockOut > 0
          ? {
              pct: (lowStockOut / lowStockProducts) * 100,
              className: "bg-neu-solid-red",
              label: `${lowStockOut} ${t("inventory.outOfStock")}`,
            }
          : null,
        lowStockLow > 0
          ? {
              pct: (lowStockLow / lowStockProducts) * 100,
              className: "bg-neu-solid-amber",
              label: `${lowStockLow} ${t("inventory.lowStock")}`,
            }
          : null,
      ].filter((seg): seg is StatBarSegment => seg !== null)
    : [];

  // Human label for the active range (KPI card title + trend subtitle).
  const rangeLabel =
    rangePreset === "7d"
      ? t("dashboard.range7d")
      : rangePreset === "30d"
        ? t("dashboard.range30d")
        : rangePreset === "mtd"
          ? t("dashboard.rangeMtd")
          : t("dashboard.rangeToday");

  // The catalog-size tile is owned by the shared <TotalProductsCard>, so its
  // number is read out here rather than stated inside the `stats` array.
  const totalProductsCount = data?.totalProducts ?? 0;

  const stats: DashboardStatEntry[] = data
    ? [
        {
          key: "range",
          label: t("dashboard.revenueRange").replace("{range}", rangeLabel),
          value: formatCurrency(data.rangeRevenue),
          numericValue: data.rangeRevenue,
          icon: "cash",
          tone: "success",
          delta: todayDelta,
          deltaLabel: t("dashboard.vsPrevPeriod"),
          sub: `${data.rangeOrders} ${t("dashboard.transactions")}`,
        },
        {
          key: "month",
          label: t("dashboard.thisMonth"),
          value: formatCurrency(data.monthRevenue),
          numericValue: data.monthRevenue,
          icon: "trend",
          tone: "brand",
          delta: monthDelta,
          deltaLabel: t("dashboard.vsLastMonth"),
          sub: `${data.monthOrders} ${t("dashboard.orders")}`,
        },
        // Rendered by <TotalProductsCard>; this entry only holds the slot.
        { key: "products" },
        {
          key: "alerts",
          label: t("dashboard.needsRestock"),
          value: String(lowStockProducts),
          numericValue: lowStockProducts,
          formatValue: (v) => String(Math.round(v)),
          icon: "alert",
          tone: alertSummary.critical > 0 ? "danger" : lowStockProducts > 0 ? "warning" : "success",
          sub:
            alertSummary.total > 0
              ? t("dashboard.lowStockAcross")
                  .replace("{alerts}", String(alertSummary.total))
                  .replace("{locations}", String(alertLocations))
              : t("dashboard.allStocked"),
          bar: lowStockBar,
          barLabel: t("dashboard.lowStockSplit")
            .replace("{out}", String(lowStockOut))
            .replace("{low}", String(lowStockLow)),
        },
        {
          key: "dues",
          label: t("dashboard.outstandingDues"),
          value: formatCurrency(data.outstandingDues ?? 0),
          numericValue: data.outstandingDues ?? 0,
          icon: "wallet",
          tone: (data.outstandingDues ?? 0) > 0 ? "warning" : "success",
          sub:
            (data.outstandingDuesOrders ?? 0) > 0
              ? t("dashboard.outstandingDuesSub")
                  .replace("{count}", String(data.outstandingDuesOrders))
              : t("dashboard.noDues"),
        },
      ]
    : [];

  // Role-gated quick actions (hidden entirely if the role has no access)
  const quickActions: Array<{
    href: string;
    label: string;
    description: string;
    icon: StatIconName;
    tone: StatTone;
  }> = [
    { href: "/pos", label: t("pos.newSale"), description: t("dashboard.quickPos"), icon: "bag", tone: "success" },
    { href: "/products", label: t("products.addProduct"), description: t("dashboard.quickProducts"), icon: "box", tone: "brand" },
    { href: "/inventory", label: t("inventory.newTransfer"), description: t("dashboard.quickInventory"), icon: "trend", tone: "info" },
    { href: "/reports/sales", label: t("reports.salesReport"), description: t("dashboard.quickReports"), icon: "chart", tone: "warning" },
  ];
  const visibleQuickActions = role ? quickActions.filter((action) => canAccessRoute(role, action.href)) : quickActions;

  const dateLabel = React.useMemo(
    () =>
      new Date().toLocaleDateString(locale === "ur" ? "ur-PK" : "en-US", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    [locale]
  );

  // Time-of-day greeting, personalized with the signed-in user's name.
  const greeting = React.useMemo(() => {
    const hour = new Date().getHours();
    const base =
      hour < 5
        ? t("dashboard.greeting.night")
        : hour < 12
          ? t("dashboard.greeting.morning")
          : hour < 17
            ? t("dashboard.greeting.afternoon")
            : t("dashboard.greeting.evening");
    return session?.user?.name ? `${base}, ${session.user.name.split(" ")[0]}` : base;
  }, [t, session?.user?.name]);

  const maxSold = Math.max(1, ...(data?.topProducts.map((p) => p.totalSold) ?? [1]));
  const todayTotalOrders = data?.todayHourly.reduce((s, h) => s + h.orders, 0) ?? 0;
  const hasHourlyData = (data?.todayHourly ?? []).some((h) => h.revenue > 0);
  const rangeDays = data?.rangeMeta?.days ?? 1;
  const hasRangeData = (data?.rangeRevenue ?? 0) > 0;

  // Group the 7-day × 24-hour series into day rows for the heatmap.
  const heatmapRows = React.useMemo(() => {
    const byDate = new Map<string, Array<{ hour: number; revenue: number; orders: number }>>();
    for (const h of data?.weekHourly ?? []) {
      const arr = byDate.get(h.date) ?? [];
      arr.push(h);
      byDate.set(h.date, arr);
    }
    return Array.from(byDate.entries()).map(([date, cells]) => ({
      date,
      cells: cells.sort((a, b) => a.hour - b.hour),
    }));
  }, [data]);
  const heatmapMax = Math.max(1, ...(data?.weekHourly.map((h) => h.revenue) ?? [1]));
  const heatmapHasData = (data?.weekHourly ?? []).some((h) => h.revenue > 0);

  const updatedLabel = updatedAt
    ? `${t("dashboard.updatedAt")} ${updatedAt.toLocaleTimeString(locale === "ur" ? "ur-PK" : "en-US", { hour: "2-digit", minute: "2-digit" })}`
    : t("dashboard.updatedAt");

  // Order-status donut palette — one color per known status.
  //
  // These are SERIES fills drawn on the page background, so they take the
  // mode-aware `--neu-ink-*` roles rather than the mode-stable
  // `--neu-solid-*` ones: a solid is tuned for a white glyph ON it and only
  // scores 2.26:1 on dark `--neu-bg`, whereas every ink role clears 3:1 as a
  // graphic in BOTH modes (cyan 6.10/8.09, green 5.98/8.40, amber 5.95/8.76,
  // red 5.43/5.29) with no `dark:` twin needed. `pending` was a lighter amber
  // (`warning-400`, 1.80:1 — effectively invisible); the amber family has no
  // second 3:1-safe rank, so it becomes the neutral slate `faint` instead,
  // which also reads better for "not started yet".
  const STATUS_COLORS: Record<string, string> = {
    completed: "var(--neu-ink-green)",
    confirmed: "var(--neu-accent-line)",
    processing: "var(--neu-ink-amber)",
    pending: "var(--neu-text-faint)",
    cancelled: "var(--neu-ink-red)",
    refunded: "var(--neu-accent-red)",
    partially_refunded: "var(--neu-ink-amber)",
  };
  const donutData = (data?.orderStatusBreakdown ?? []).map((s) => ({
    label: t(`orders.${s.status}`),
    value: s.count,
    color: STATUS_COLORS[s.status] ?? "var(--neu-text-muted)",
  }));
  const hasDonutData = donutData.some((d) => d.value > 0);

  /* Skeleton→content crossfade: the entrance animation keys off the
     FIRST-load boundary only (hasLoadedOnce), not the `loading` flag —
     so the 60s background refetch and the manual refresh swap values
     with a quick opacity fade instead of replaying the stagger pop-in
     every minute. Content keeps a persistent fade transition; the
     skeleton only ever appears for the initial load. */
  const hasLoadedOnce = !loading || data !== null;

  return (
    <div className="stagger space-y-6">
      {/* Personalized greeting — welcome by name, time-aware, with the
          store's pulse (today's revenue + low-stock watch) right beside it. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neu-accent-ink">{greeting}</p>
          <h1 className="mt-0.5 text-2xl font-bold tracking-tight text-neu-primary sm:text-3xl">
            {t("dashboard.title")}
          </h1>
          <p className="mt-1 text-sm text-neu-faint">{t("dashboard.description")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* Date-range + warehouse scope — every widget re-queries on change,
              and both selections persist per user. */}
          <div
            role="group"
            aria-label={t("dashboard.rangeGroupLabel")}
            className="flex h-8 items-center rounded-full border border-neu-hairline bg-neu-bg p-0.5"
          >
            {(["today", "7d", "30d", "mtd"] as const).map((preset) => (
              <button
                key={preset}
                onClick={() => setRangePreset(preset)}
                aria-pressed={rangePreset === preset}
                className={cn(
                  "h-7 rounded-full px-2.5 text-xs font-medium transition-colors sm:px-3",
                  rangePreset === preset
                    ? "bg-neu-accent-solid text-white shadow-sm"
                    : "text-neu-faint hover:text-neu-primary"
                )}
              >
                {t(
                  preset === "today"
                    ? "dashboard.rangeToday"
                    : preset === "7d"
                      ? "dashboard.range7d"
                      : preset === "30d"
                        ? "dashboard.range30d"
                        : "dashboard.rangeMtd"
                )}
              </button>
            ))}
          </div>
          {warehouses.length > 1 && (
            <>
              <label className="sr-only" htmlFor="dashboard-scope">
                {t("dashboard.dataScope")}
              </label>
              <select
                id="dashboard-scope"
                value={warehouseScope ?? ""}
                onChange={(e) => setWarehouseScope(e.target.value || null)}
                className="h-8 rounded-full border border-neu-hairline bg-neu-bg px-3 text-xs font-medium text-neu-muted transition-colors neu-focus"
              >
                <option value="">{t("dashboard.allWarehouses")}</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="flex items-center gap-1.5 rounded-full border border-neu-hairline bg-neu-bg px-3 py-1.5 text-xs font-medium text-neu-muted">
            <svg className="h-3.5 w-3.5 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
            {dateLabel}
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-neu-hairline bg-neu-bg px-3 py-1.5 text-xs font-medium text-neu-muted">
            <span className={cn("h-1.5 w-1.5 rounded-full", refreshing ? "animate-pulse bg-neu-accent-solid" : "bg-neu-solid-green")} />
            {refreshing ? t("dashboard.refreshing") : updatedLabel}
          </span>
          <Badge variant="primary" dot>
            {t("dashboard.live")}
          </Badge>
          <button
            onClick={() => {
              loadData();
              loadActivity();
              void refreshAlerts();
            }}
            disabled={refreshing}
            title={t("dashboard.refresh")}
            aria-label={t("dashboard.refresh")}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-neu-hairline bg-neu-bg text-neu-faint transition-colors hover:bg-neu-sunken hover:text-neu-accent-ink disabled:opacity-50"
          >
            {refreshing ? (
              <Spinner />
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ─── Quick actions (permission-aware) ─── */}
      {visibleQuickActions.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neu-faint">{t("dashboard.quickActions")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {visibleQuickActions.map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className="group flex items-center gap-3 rounded-xl border border-neu-hairline bg-neu-bg p-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-neu-accent-line hover:shadow-md"
              >
                <span
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105",
                    action.tone === "success" && "bg-neu-wash-green text-neu-ink-green",
                    action.tone === "brand" && "bg-neu-accent-wash text-neu-accent-ink",
                    action.tone === "info" && "bg-neu-wash-cyan text-neu-ink-cyan",
                    action.tone === "warning" && "bg-neu-wash-amber text-neu-ink-amber",
                    action.tone === "danger" && "bg-neu-wash-red text-neu-ink-red"
                  )}
                >
                  <StatIcon name={action.icon} className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-neu-primary">
                    {action.label}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-neu-faint">
                    {action.description}
                  </span>
                </span>
                <svg className="h-4 w-4 shrink-0 text-neu-faint transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ─── Stat cards ─── */}
      <div className="grid grid-cols-1 gap-4 transition-opacity duration-300 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {!hasLoadedOnce
          ? Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <div className="space-y-3">
                    <div className="skeleton h-10 w-10 rounded-xl" />
                    <div className="skeleton h-4 w-24 rounded" />
                    <div className="skeleton h-7 w-28 rounded" />
                    <div className="skeleton h-3 w-20 rounded" />
                  </div>
                </CardContent>
              </Card>
            ))
          : stats.map((stat) =>
              // The `products` entry carries no card props — the shared card
              // owns them — so its presence is the branch condition.
              "label" in stat ? (
                <StatCard
                  key={stat.key}
                  label={stat.label}
                  value={stat.value}
                  icon={stat.icon}
                  tone={stat.tone}
                  delta={stat.delta}
                  deltaLabel={stat.deltaLabel}
                  sub={stat.sub}
                  bar={stat.bar}
                  barLabel={stat.barLabel}
                  numericValue={stat.numericValue}
                  formatValue={stat.formatValue}
                />
              ) : (
                <TotalProductsCard key={stat.key} value={totalProductsCount} tone="info" />
              )
            )}
      </div>

      {/* ─── Revenue trend + low stock + live activity ─── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* 7-day revenue trend */}
        <Card className="lg:col-span-2 lg:row-span-1">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-accent-wash text-neu-accent-ink">
                  <StatIcon name="trend" className="h-4 w-4" />
                </span>
                {t("dashboard.revenueWeek")}
              </CardTitle>
              {data && (
                <div className="flex items-center gap-3 text-xs text-neu-faint">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-neu-accent-solid" />
                    {t("reports.revenue")}
                  </span>
                  <span>
                    {data.weekTrend.reduce((s, d) => s + d.orders, 0)} {t("dashboard.orders")}
                  </span>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="transition-opacity duration-300">
            {!hasLoadedOnce ? (
              <div className="skeleton h-[190px] w-full rounded-lg" />
            ) : weekTrendData.length === 0 || weekTrendData.every((d) => d.value === 0) ? (
              <div className="flex h-[190px] items-center justify-center rounded-lg border border-dashed border-neu-hairline">
                <p className="text-sm text-neu-faint">{t("dashboard.noWeekData")}</p>
              </div>
            ) : (
              <BarChart data={weekTrendData} height={190} compactValueLabels />
            )}
          </CardContent>
        </Card>

        {/* Low-stock alerts */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-amber text-neu-ink-amber">
                  <StatIcon name="alert" className="h-4 w-4" />
                </span>
                {t("dashboard.lowStockWidget")}
                {alerts.length > 0 && (
                  <Badge variant="danger" size="sm">
                    {alerts.length}
                  </Badge>
                )}
                {/* Opt-in early-warning tally. Shown beside — never inside — the
                    restock badge, so switching the setting on cannot change the
                    Needs Restock count. */}
                {restockSoon.length > 0 && (
                  <span
                    title={t("dashboard.restockSoonHint")}
                    className="rounded-full bg-neu-wash-cyan px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-neu-ink-cyan"
                  >
                    {restockSoon.length} {t("dashboard.restockSoon")}
                  </span>
                )}
              </CardTitle>
              <Link href="/inventory" className="text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong">
                {t("dashboard.manageStock")}
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {loading || alertsStatus === "loading" ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-8 w-8 rounded" />
                    <div className="skeleton h-4 flex-1 rounded" />
                  </div>
                ))}
              </div>
            ) : alertsStatus === "error" ? (
              <EmptyState
                height={190}
                bare
                error
                title={t("common.loadFailed")}
                description={alertsError ?? t("common.loadFailedDesc")}
                icon={
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                }
                action={
                  <Button variant="secondary" size="sm" onClick={() => void refreshAlerts()}>
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : alerts.length === 0 ? (
              <EmptyState
                height={190}
                bare
                title={t("dashboard.allWellStocked")}
                icon={
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
              />
            ) : (
              <div className="space-y-2 max-h-[320px] overflow-y-auto pe-0.5">
                {alerts.slice(0, 6).map((alert) => (
                  <AlertTileInline key={alert.id} alert={alert} t={t} />
                ))}
                {alerts.length > 6 && (
                  <Link
                    href="/inventory"
                    className="block rounded-lg bg-neu-sunken py-2 text-center text-xs font-medium text-neu-faint transition-colors hover:text-neu-primary"
                  >
                    +{alerts.length - 6} {t("dashboard.moreAlerts")}
                  </Link>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ─── Live activity feed ─── */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-cyan text-neu-ink-cyan">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-neu-solid-cyan opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-neu-solid-cyan" />
                  </span>
                </span>
                {t("dashboard.activityFeed")}
              </CardTitle>
              <Link href="/settings/audit-log" className="text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong">
                {t("dashboard.viewAll")}
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {activityLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-7 w-7 rounded-full" />
                    <div className="skeleton h-4 flex-1 rounded" />
                  </div>
                ))}
              </div>
            ) : activity.length === 0 ? (
              <EmptyState
                height={190}
                bare
                title={t("dashboard.noActivity")}
                icon={
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
              />
            ) : (
              <div className="space-y-1 max-h-[320px] overflow-y-auto pe-0.5">
                {activity.map((ev) => (
                  <div key={ev.id} className="flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-neu-sunken">
                    <span className={cn("mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", ACTIVITY_STYLES[ev.action]?.bg ?? "bg-neu-sunken text-neu-faint")}>
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d={ACTIVITY_STYLES[ev.action]?.icon ?? ACTIVITY_STYLES["update"]!.icon} />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-neu-primary">
                        <ActivitySentence
                          template={activityTemplate(t, ev.action)}
                          user={ev.user?.name ?? "—"}
                          entity={ev.entityName || ev.entity}
                          action={ev.action}
                        />
                      </p>
                      <p className="text-[10px] text-neu-faint">{timeAgo(ev.createdAt, t)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Sales by hour (today) ─── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-cyan text-neu-ink-cyan">
                <StatIcon name="clock" className="h-4 w-4" />
              </span>
              {t("dashboard.salesByHour")}
              {rangeDays === 1
                ? data?.rangeMeta && (
                    <Badge variant="default" size="sm">
                      {t("dashboard.hourlyOn").replace("{date}", data.rangeMeta.to)}
                    </Badge>
                  )
                : (
                  <span className="text-[11px] font-normal text-neu-faint">{t("dashboard.hourlyOff")}</span>
                )}
            </CardTitle>
            {data && hasHourlyData && (
              <div className="flex items-center gap-3 text-xs text-neu-faint">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-neu-solid-cyan" />
                  {t("reports.revenue")}
                </span>
                <span>{todayTotalOrders} {t("dashboard.orders")}</span>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!hasLoadedOnce ? (
            <div className="skeleton h-[150px] w-full rounded-lg" />
          ) : !hasHourlyData ? (
            <EmptyState
              height={150}
              bare
              title={t("dashboard.noHourData")}
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
          ) : (
            <BarChart data={hourlyData} height={150} color="var(--neu-accent-line)" compactValueLabels />
          )}
        </CardContent>
      </Card>

      {/* ─── Warehouse comparison — revenue share by location ─── */}
      {warehouses.length > 1 && (data?.warehouseComparison?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-accent-wash text-neu-accent-ink">
                  <StatIcon name="box" className="h-4 w-4" />
                </span>
                {t("dashboard.warehouseComparison")}
              </CardTitle>
              <span className="text-xs text-neu-faint">{t("dashboard.warehouseComparisonSub")}</span>
            </div>
          </CardHeader>
          <CardContent>
            {!hasLoadedOnce ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-4 w-28 rounded" />
                    <div className="skeleton h-1.5 flex-1 rounded" />
                    <div className="skeleton h-4 w-16 rounded" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3.5 pt-1">
                {data!.warehouseComparison!.map((w, idx) => {
                  const total = (data!.warehouseComparison ?? []).reduce((s, x) => s + x.revenue, 0) || 1;
                  const share = (w.revenue / total) * 100;
                  const isLeader = idx === 0 && w.revenue > 0;
                  return (
                    <div key={w.warehouseId} className="group">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-neu-primary">
                          <span className="min-w-0 truncate">{w.name}</span>
                          {isLeader && (
                            <Badge variant="success" size="sm">
                              #1
                            </Badge>
                          )}
                        </p>
                        <p className="shrink-0 text-sm font-bold tabular-nums text-neu-primary">
                          {formatCurrency(w.revenue)}
                          <span className="ms-1.5 text-[11px] font-normal text-neu-faint">
                            {share.toFixed(0)}% {t("dashboard.ofRevenue")}
                            <span className="mx-1 text-neu-faint">·</span>
                            {w.orders} {t("dashboard.orders")}
                          </span>
                        </p>
                        <Link
                          href="/inventory"
                          className="hidden shrink-0 text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong sm:block"
                        >
                          {t("dashboard.viewWarehouse")}
                        </Link>
                        </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neu-sunken">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-neu-accent-line to-neu-accent-line transition-all duration-500"
                          style={{ width: `${Math.max(2, share)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Refund analytics — trend (6 months) + top reasons ─── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Refund trend */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-red text-neu-ink-red">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                </span>
                {t("dashboard.refundTrend")}
              </CardTitle>
              {data && hasRefundData && (
                <div className="flex items-center gap-3 text-xs text-neu-faint">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-neu-solid-red" />
                    {t("refunds.totalRefunded")}
                  </span>
                  <span className="font-semibold tabular-nums text-neu-ink-red">{formatCurrency(refundTrendTotal)}</span>
                  <span className="hidden sm:inline">· {refundTrendCount} {t("dashboard.refunds")}</span>
                </div>
              )}
              <Link href="/refunds" className="text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong">
                {t("dashboard.viewRefunds")}
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {!hasLoadedOnce ? (
              <div className="skeleton h-[190px] w-full rounded-lg" />
            ) : !hasRefundData ? (
              <EmptyState
                height={190}
                bare
                title={t("dashboard.noRefundData")}
                icon={
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                }
              />
            ) : (
              <BarChart
                data={refundTrendData}
                height={190}
                color="var(--neu-ink-red)"
                compactValueLabels
                onBarClick={(d) => {
                  // Drill into the month's refunds on the Refunds ledger
                  const range = monthRange(String(d["month"] ?? ""));
                  if (range) router.push(`/refunds?from=${range.from}&to=${range.to}`);
                }}
              />
            )}
          </CardContent>
        </Card>

        {/* Top refund reasons */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-red text-neu-ink-red">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </span>
                {t("dashboard.topRefundReasons")}
              </CardTitle>
              <Link href="/refunds" className="text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong">
                {t("dashboard.viewRefunds")}
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {!hasLoadedOnce ? (
              <div className="skeleton h-[190px] w-full rounded-lg" />
            ) : !hasReasonData ? (
              <EmptyState
                height={190}
                bare
                title={t("dashboard.noRefundReasons")}
                icon={
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
                  </svg>
                }
              />
            ) : (
              <div className="space-y-3.5 pt-1">
                {refundReasons.slice(0, 5).map((r) => (
                  <div key={r.reason ?? "__none__"} className="group">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium text-neu-primary">
                        {r.reason || t("refunds.noReason")}
                      </p>
                      <p className="shrink-0 text-sm font-bold tabular-nums text-neu-ink-red">
                        {formatCurrency(r.total)}
                      </p>
                    </div>
                    <p className="mt-0.5 text-[11px] text-neu-faint">
                      {r.count} {r.count === 1 ? t("dashboard.refund") : t("dashboard.refunds")}
                    </p>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neu-sunken">
                      <div
                        className="h-full rounded-full bg-neu-ink-red transition-all duration-500"
                        style={{ width: `${Math.max(4, (r.total / maxReasonTotal) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Sales heatmap — last 7 days × 24 hours ─── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-accent-wash text-neu-accent-ink">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148 3.352-3.352m-6.75 3.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
                </svg>
              </span>
              {t("dashboard.heatmapTitle")}
            </CardTitle>
            {data && heatmapHasData && (
              <div className="flex items-center gap-3 text-xs text-neu-faint">
                <span className="flex items-center gap-1.5">
                  {t("dashboard.legendLess")}
                  <span className="h-3 w-6 rounded-[3px] bg-neu-accent-line/10" />
                  <span className="h-3 w-6 rounded-[3px] bg-neu-accent-line/35" />
                  <span className="h-3 w-6 rounded-[3px] bg-neu-accent-line/70" />
                  <span className="h-3 w-6 rounded-[3px] bg-neu-accent-solid dark:bg-neu-accent-solid" />
                  {t("dashboard.legendMore")}
                </span>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!hasLoadedOnce ? (
            <div className="skeleton h-[210px] w-full rounded-lg" />
          ) : !heatmapHasData ? (
            <EmptyState
              height={150}
              bare
              title={t("dashboard.noHeatmapData")}
              icon={
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148 3.352-3.352m-6.75 3.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
                </svg>
              }
            />
          ) : (
            <div className="overflow-x-auto pb-1">
              <div className="min-w-[820px]">
                {/* Hour axis */}
                <div className="grid grid-cols-[3.5rem_repeat(24,minmax(0,1fr))] gap-1 ps-1">
                  <span />
                  {Array.from({ length: 24 }, (_, hour) => (
                    <span key={hour} className="text-center text-[10px] font-medium text-neu-faint">
                      {hour % 3 === 0 ? hourLabel(hour) : ""}
                    </span>
                  ))}
                </div>
                {/* Day rows */}
                <div className="mt-1.5 space-y-1">
                  {heatmapRows.map((row) => {
                    const isToday = row.date === new Date().toISOString().split("T")[0];
                    const dayLabel = new Date(`${row.date}T00:00:00`).toLocaleDateString(
                      locale === "ur" ? "ur-PK" : "en-US",
                      { weekday: "short" }
                    );
                    const dayTotal = row.cells.reduce((s, c) => s + c.revenue, 0);
                    return (
                      <div
                        key={row.date}
                        className={cn(
                          "grid grid-cols-[3.5rem_repeat(24,minmax(0,1fr))] items-center gap-1 rounded-md",
                          isToday && "bg-neu-accent-line/5 ring-1 ring-inset ring-neu-accent-line/20"
                        )}
                      >
                        <span className="flex items-center justify-between pe-1 text-[10px] font-semibold text-neu-faint">
                          <span className={cn(isToday && "text-neu-accent-ink")}>
                            {dayLabel}
                            {isToday && <span className="ms-1 rounded bg-neu-accent-wash px-1 text-[8px] font-bold uppercase tracking-wide text-neu-accent-ink-strong">{t("dashboard.today")}</span>}
                          </span>
                          <span className="font-mono text-[9px] font-normal text-neu-faint tabular-nums">
                            {formatCurrency(dayTotal)}
                          </span>
                        </span>
                        {row.cells.map((cell) => {
                          const intensity = cell.revenue > 0 ? Math.max(0.08, Math.min(1, cell.revenue / heatmapMax)) : 0;
                          return (
                            <div
                              key={cell.hour}
                              className="group/cell relative h-6 rounded-[3px] bg-neu-sunken transition-shadow hover:ring-2 hover:ring-neu-accent-line"
                              title={`${dayLabel} · ${hourLabel(cell.hour)} — ${formatCurrency(cell.revenue)} · ${cell.orders} ${t("dashboard.orders")}`}
                            >
                              <div
                                className="absolute inset-0 rounded-[3px] bg-neu-accent-solid transition-opacity dark:bg-neu-accent-solid"
                                style={{ opacity: intensity === 0 ? 0 : intensity }}
                              />
                              {cell.revenue > 0 && (
                                <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/cell:opacity-100">
                                  <span className="rounded bg-neu-scrim/80 px-1 py-px text-[9px] font-semibold text-white">
                                    {cell.orders}
                                  </span>
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Recent orders + top products ─── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent orders */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-cyan text-neu-ink-cyan">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007z" />
                  </svg>
                </span>
                {t("dashboard.recentOrders")}
              </CardTitle>
              <Link href="/orders" className="flex items-center gap-1 text-xs font-medium text-neu-accent-ink hover:text-neu-accent-ink-strong">
                {t("dashboard.viewAll")}
                <svg className="h-3.5 w-3.5 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="px-2 pb-2 sm:px-6 sm:pb-6">
            {!hasLoadedOnce ? (
              <div className="space-y-2 px-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 py-2">
                    <div className="skeleton h-4 w-28 rounded" />
                    <div className="skeleton h-4 flex-1 rounded" />
                    <div className="skeleton h-4 w-14 rounded" />
                  </div>
                ))}
              </div>
            ) : !data || data.recentOrders.length === 0 ? (
              <div className="mx-3">
                <EmptyState
                  height={192}
                  bare
                  title={t("dashboard.noOrdersToday")}
                  icon={
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007z" />
                    </svg>
                  }
                  action={
                    <Link
                      href="/pos"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-neu-accent-solid px-3.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-neu-accent-solid-strong active:scale-[0.98]"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                      </svg>
                      {t("pos.newSale")}
                    </Link>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-neu-hairline">
                {data.recentOrders.map((order) => (
                  <li key={order.id}>
                    <Link
                      href="/orders"
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-neu-sunken"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-neu-primary">{order.orderNumber}</p>
                        <p className="mt-0.5 truncate text-xs text-neu-faint">
                          {order.customer?.name ?? t("orders.walkIn")}
                          <span className="mx-1 text-neu-faint">·</span>
                          {timeAgo(order.createdAt, t)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                        <span className="hidden text-xs text-neu-faint sm:block">{order.user.name}</span>
                        <Badge variant={STATUS_VARIANT[order.status] ?? "default"} size="sm">
                          {t(`orders.${order.status}`)}
                        </Badge>
                        {/* Money reads whole — a fixed w-24 elided large totals
                            into "…". min-w + end-align keeps the column tidy. */}
                        <span className="min-w-24 shrink-0 text-end text-sm font-bold text-neu-primary tabular-nums">
                          {formatCurrency(order.total)}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Top products */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-green text-neu-ink-green">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                </svg>
              </span>
              {t("dashboard.topProducts")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasLoadedOnce ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-8 w-8 rounded-full" />
                    <div className="skeleton h-4 flex-1 rounded" />
                    <div className="skeleton h-4 w-14 rounded" />
                  </div>
                ))}
              </div>
            ) : !data || data.topProducts.length === 0 ? (
              <EmptyState
                height={192}
                bare
                title={t("dashboard.noSalesData")}
                icon={
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
                  </svg>
                }
              />
            ) : (
              <div className="space-y-3">
                {data.topProducts.map((product, index) => {
                  // Podium in neu inks: gold / silver / bronze. These were the
                  // last raw Tailwind palette classes in the app (`bg-amber-100`,
                  // `bg-orange-100`) — the raw palette is now unreferenced.
                  const rankStyles = ["bg-neu-wash-amber text-neu-ink-amber", "bg-neu-sunken text-neu-muted", "bg-neu-wash-red text-neu-ink-red"];
                  return (
                    <div key={product.name} className="group">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums",
                            index < 3 ? rankStyles[index] : "bg-neu-sunken text-neu-faint"
                          )}
                        >
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            {/* name gives way, money never: min-w-0 + truncate on
                                the label, whole amount on the trailing side */}
                            <p className="min-w-0 truncate text-sm font-medium text-neu-primary">{product.name}</p>
                            <p className="shrink-0 text-sm font-bold text-neu-primary tabular-nums">
                              {formatCurrency(product.revenue)}
                            </p>
                          </div>
                          <p className="text-[11px] text-neu-faint">
                            {product.totalSold} {t("dashboard.sold")}
                          </p>
                        </div>
                      </div>
                      {/* sold-share bar */}
                      <div className="ms-10 mt-1.5 h-1.5 overflow-hidden rounded-full bg-neu-sunken">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-neu-accent-line to-neu-accent-line transition-all duration-500"
                          style={{ width: `${Math.max(4, (product.totalSold / maxSold) * 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                <p className="pt-1 text-center text-[11px] text-neu-faint">
                  30 {t("dashboard.days")} · {t("dashboard.soldByUnits")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Top Customers + Order Status Breakdown ─── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top Customers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-green text-neu-ink-green">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
              </span>
              {t("dashboard.topCustomers")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasLoadedOnce ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-8 w-8 rounded-full" />
                    <div className="skeleton h-4 flex-1 rounded" />
                    <div className="skeleton h-4 w-14 rounded" />
                  </div>
                ))}
              </div>
            ) : !data || data.topCustomers.length === 0 ? (
              <EmptyState
                height={192}
                bare
                title={t("dashboard.noCustomerData")}
                icon={
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                  </svg>
                }
              />
            ) : (
              <div className="space-y-3">
                {data.topCustomers.map((customer, index) => {
                  const avatarTones = [
                    "bg-neu-wash-amber text-neu-ink-amber",
                    "bg-neu-sunken text-neu-muted",
                    "bg-neu-wash-cyan text-neu-ink-cyan",
                    "bg-neu-accent-wash text-neu-accent-ink-strong",
                    "bg-neu-wash-green text-neu-ink-green",
                  ];
                  return (
                    <div key={customer.name} className="flex items-center gap-3">
                      <span
                        className={cn(
                          "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums",
                          avatarTones[index] ?? "bg-neu-sunken text-neu-faint"
                        )}
                        title={`#${index + 1}`}
                      >
                        {getInitials(customer.name)}
                        <span className="absolute -bottom-0.5 -end-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-neu-scrim text-[8px] font-bold text-white dark:border-neu-hairline dark:bg-neu-sunken dark:text-neu-muted">
                          {index + 1}
                        </span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="min-w-0 truncate text-sm font-medium text-neu-primary">{customer.name}</p>
                        <p className="text-[11px] text-neu-faint">
                          {customer.orders} {t("dashboard.orders")}
                        </p>
                      </div>
                      <span className="text-sm font-bold tabular-nums text-neu-primary">
                        {formatCurrency(customer.revenue)}
                      </span>
                    </div>
                  );
                })}
                <p className="pt-1 text-center text-[11px] text-neu-faint">
                  30 {t("dashboard.days")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Order Status Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neu-wash-cyan text-neu-ink-cyan">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
                </svg>
              </span>
              {t("dashboard.orderStatusBreakdown")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasLoadedOnce ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-4 w-24 rounded" />
                    <div className="skeleton h-4 flex-1 rounded" />
                    <div className="skeleton h-4 w-14 rounded" />
                  </div>
                ))}
              </div>
            ) : !data || data.orderStatusBreakdown.length === 0 ? (
              <EmptyState
                height={192}
                bare
                title={t("dashboard.noOrderData")}
                icon={
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
                  </svg>
                }
              />
            ) : (
              <div className="space-y-5">
                {/* Donut — order mix at a glance */}
                {hasDonutData && donutData.length > 1 && (
                  <div className="rounded-xl border border-neu-hairline bg-neu-sunken/50 p-4">
                    <DonutChart
                      data={donutData}
                      size={150}
                      center={{ value: String(data.orderStatusBreakdown.reduce((s, o) => s + o.count, 0)), label: t("dashboard.orders") }}
                    />
                  </div>
                )}

                <div className="space-y-3">
                {data.orderStatusBreakdown
                  .sort((a, b) => b.count - a.count)
                  .map((item) => {
                    const totalCount = data.orderStatusBreakdown.reduce((s, o) => s + o.count, 0);
                    const pct = totalCount > 0 ? (item.count / totalCount) * 100 : 0;
                    return (
                      <div key={item.status}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Badge variant={STATUS_VARIANT[item.status] ?? "default"} size="sm">
                              {t(`orders.${item.status}`)}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold tabular-nums text-neu-primary">
                              {item.count}
                            </span>
                            <span className="text-xs text-neu-faint">
                              {formatCurrency(item.total)}
                            </span>
                          </div>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neu-sunken">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-500",
                              item.status === "completed" && "bg-neu-solid-green",
                              item.status === "pending" && "bg-neu-solid-amber",
                              item.status === "cancelled" && "bg-neu-solid-red",
                              item.status === "refunded" && "bg-neu-solid-red",
                              item.status === "partially_refunded" && "bg-neu-solid-amber",
                              !(["completed", "pending", "cancelled", "refunded", "partially_refunded"].includes(item.status)) && "bg-neu-accent-solid"
                            )}
                            style={{ width: `${Math.max(4, pct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}