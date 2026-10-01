"use client";

import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useI18n } from "@/components/providers/i18n-provider";
import { SortableTh } from "@/components/ui/sortable-th";
import { formatDate, formatTime } from "@/lib/utils";
import { fetchListPayload } from "@/lib/api/list-fetch";

/* ═══════════════════════════════════════════════════════════════
   AUDIT LOG PAGE
   Displays system activity history with entity, action, and
   user filters. Shows old/new value diffs for each change.
   ═══════════════════════════════════════════════════════════════ */

interface AuditLogEntry {
  id: string;
  action: string;
  entity: string;
  entityId?: string | null;
  entityName?: string | null;
  oldValues?: string | null;
  newValues?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string | Date;
  user: { id: string; name: string; email: string; role: string };
}

const ACTION_COLORS: Record<string, "success" | "warning" | "danger" | "info" | "default"> = {
  create: "success",
  update: "info",
  delete: "danger",
  login: "success",
  logout: "default",
  refund: "warning",
  stock_adjust: "warning",
  stock_transfer: "info",
  checkout: "success",
  status_change: "info",
};

/* Entity glyphs. These were a 12-entry emoji map — the largest cluster of
   glyph "icons" left in the app, and the reason a row's icon had a different
   weight, colour and baseline from every other icon on the screen. They are now
   inline SVG on the shared ink ladder: one stroke weight, one size, and a
   colour that follows `currentColor`.

   The map is a `d` path per entity, so an unknown entity still renders a
   document rather than nothing. */
const ENTITY_ICONS: Record<string, string> = {
  product: "M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9",
  order: "M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z",
  customer: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z",
  supplier: "M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12",
  warehouse: "M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21",
  user: "M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z",
  settings: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281zM15 12a3 3 0 11-6 0 3 3 0 016 0z",
  category: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z",
  brand: "M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3zM6 6h.008v.008H6V6z",
  purchase_order: "M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75",
  stock_transfer: "M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5",
  stock_level: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
};

/* Unknown entities get the document glyph instead of a missing icon. */
const ENTITY_ICON_FALLBACK =
  "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z";

function EntityIcon({ entity, className }: { entity: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden
      className={`shrink-0 ${className ?? "h-4 w-4"}`}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d={ENTITY_ICONS[entity] ?? ENTITY_ICON_FALLBACK}
      />
    </svg>
  );
}

export default function AuditLogPage() {
  const { t } = useI18n();
  const [logs, setLogs] = React.useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(0);
  const [entityFilter, setEntityFilter] = React.useState("");
  const [actionFilter, setActionFilter] = React.useState("");
  // Server-side sort in the shared "field.order" wire format — the API
  // clamps it to its allow-list. Time opens high→low; everything else A→Z.
  const [sort, setSort] = React.useState("createdAt.desc");
  function toggleSort(field: string) {
    setSort((s) => {
      if (s.startsWith(`${field}.`)) {
        return `${field}.${s.endsWith(".asc") ? "desc" : "asc"}`;
      }
      return `${field}.${field === "createdAt" ? "desc" : "asc"}`;
    });
  }
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const fetchLogs = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (entityFilter) params.set("entity", entityFilter);
      if (actionFilter) params.set("action", actionFilter);
      params.set("sort", sort);
      const data = await fetchListPayload<{
        logs?: AuditLogEntry[];
        total?: number;
        totalPages?: number;
      }>(`/api/audit-log?${params}`);
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(data.totalPages ?? 0);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [page, entityFilter, actionFilter, sort]);

  React.useEffect(() => { fetchLogs(); }, [fetchLogs]);
  React.useEffect(() => { setPage(1); }, [entityFilter, actionFilter, sort]);

  function parseValues(raw: string | null | undefined): Record<string, unknown> | null {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("settings.auditLog")}
        description={t("settings.auditLogDescription")}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("settings.title"), href: "/settings" },
          { label: t("settings.auditLog") },
        ]}
      />

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <select
              className="h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
            >
              <option value="">{t("settings.auditAllEntities")}</option>
              <option value="product">{t("settings.auditEntityProduct")}</option>
              <option value="order">{t("settings.auditEntityOrder")}</option>
              <option value="customer">{t("settings.auditEntityCustomer")}</option>
              <option value="supplier">{t("settings.auditEntitySupplier")}</option>
              <option value="warehouse">{t("settings.auditEntityWarehouse")}</option>
              <option value="user">{t("settings.auditEntityUser")}</option>
              <option value="settings">{t("settings.auditEntitySettings")}</option>
              <option value="category">{t("settings.auditEntityCategory")}</option>
              <option value="brand">{t("settings.auditEntityBrand")}</option>
              <option value="purchase_order">{t("settings.auditEntityPO")}</option>
            </select>
            <select
              className="h-9 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
            >
              <option value="">{t("settings.auditAllActions")}</option>
              <option value="create">{t("settings.auditActionCreate")}</option>
              <option value="update">{t("settings.auditActionUpdate")}</option>
              <option value="delete">{t("settings.auditActionDelete")}</option>
              <option value="login">{t("settings.auditActionLogin")}</option>
              <option value="checkout">{t("settings.auditActionCheckout")}</option>
              <option value="refund">{t("settings.auditActionRefund")}</option>
              <option value="stock_adjust">{t("settings.auditActionStockAdjust")}</option>
              <option value="stock_transfer">{t("settings.auditActionStockTransfer")}</option>
              <option value="status_change">{t("settings.auditActionStatusChange")}</option>
            </select>
            <span className="text-sm text-neu-faint">{t("settings.auditEntriesCount", { n: total })}</span>
          </div>
        </CardContent>
      </Card>

      {/* Log Entries */}
      <Card>
        <div className="overflow-x-auto">
          {loading ? (
            <table className="w-full">
              <tbody>
                <TableSkeleton rows={6} />
              </tbody>
            </table>
          ) : loadError ? (
            <EmptyState
              bare
              error
              icon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              }
              title={t("common.loadFailed")}
              description={t("common.loadFailedDesc")}
              action={
                <Button variant="secondary" size="sm" onClick={fetchLogs}>
                  {t("common.retry")}
                </Button>
              }
            />
          ) : logs.length === 0 ? (
            <EmptyState
              bare
              icon={
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                </svg>
              }
              title={t("settings.auditLogEmpty")}
              description={t("settings.auditLogEmptyHint")}
            />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-neu-hairline bg-neu-sunken">
                  <SortableTh label={t("settings.auditColTime")} active={sort.startsWith("createdAt.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("createdAt")} />
                  <SortableTh label={t("settings.auditColUser")} active={sort.startsWith("user.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("user")} />
                  <SortableTh label={t("settings.auditColAction")} active={sort.startsWith("action.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("action")} />
                  <SortableTh label={t("settings.auditColEntity")} active={sort.startsWith("entity.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("entity")} />
                  <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-neu-faint">{t("settings.auditColDetails")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neu-hairline">
                {logs.map((log) => {
                  const newVals = parseValues(log.newValues);
                  const isExpanded = expandedId === log.id;
                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        className="cursor-pointer hover:bg-neu-sunken/50 transition-colors"
                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                      >
                        <td className="px-4 py-3 text-xs text-neu-faint whitespace-nowrap">
                          <div>{formatDate(String(log.createdAt || new Date()), "short")}</div>
                          <div className="text-neu-faint">{formatTime(String(log.createdAt || new Date()))}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-neu-primary">{log.user.name}</div>
                          <div className="text-xs text-neu-faint">{log.user.role}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={ACTION_COLORS[log.action] ?? "default"} size="sm">
                            {log.action}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-sm text-neu-primary">
                            <EntityIcon entity={log.entity} />
                            {log.entity}
                          </span>
                          {log.entityName && (
                            <span className="ms-2 text-xs text-neu-faint">({log.entityName})</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-neu-faint">
                          {log.newValues && (
                            <span className="text-neu-ink-green">+{Object.keys(newVals ?? {}).length} {t("settings.auditFields")}</span>
                          )}
                          {log.oldValues && (
                            <span className="ms-2 text-neu-ink-red">-{Object.keys(parseValues(log.oldValues) ?? {}).length} {t("settings.auditFields")}</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={5} className="border-b border-neu-hairline bg-neu-sunken/50 px-4 py-3">
                            <div className="grid gap-4 sm:grid-cols-2">
                              {log.oldValues && (
                                <div>
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-ink-red mb-1">{t("settings.auditBefore")}</p>
                                  <pre className="rounded-lg bg-neu-wash-red p-2 text-xs text-neu-ink-red overflow-x-auto max-h-40 overflow-y-auto">
                                    {JSON.stringify(parseValues(log.oldValues), null, 2)}
                                  </pre>
                                </div>
                              )}
                              {log.newValues && (
                                <div>
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-ink-green mb-1">{t("settings.auditAfter")}</p>
                                  <pre className="rounded-lg bg-neu-wash-green p-2 text-xs text-neu-ink-green overflow-x-auto max-h-40 overflow-y-auto">
                                    {JSON.stringify(parseValues(log.newValues), null, 2)}
                                  </pre>
                                </div>
                              )}
                              {!log.oldValues && !log.newValues && (
                                <p className="text-xs text-neu-faint">{t("settings.auditNoChanges")}</p>
                              )}
                            </div>
                            {log.ipAddress && (
                              <p className="mt-2 text-[10px] text-neu-faint">IP: {log.ipAddress}</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-neu-hairline px-4 py-3">
            <p className="text-sm text-neu-faint">
              {t("common.page")} {page} {t("common.of")} {totalPages}
            </p>
            <div className="flex gap-1">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t("common.previous")}
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                {t("common.next")}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
