"use client";

import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/providers/i18n-provider";
import { ROLE_LABELS, ROLE_COLORS, ROLE_PERMISSIONS, type Permission, type Role } from "@/lib/auth/rbac";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   ROLES & PERMISSIONS PAGE
   Read-only matrix of every role and the permissions it grants,
   generated directly from the RBAC configuration in src/lib/rbac.ts.
   ═══════════════════════════════════════════════════════════════ */

const ROLES: Role[] = ["super_admin", "admin", "manager", "cashier", "inventory_clerk", "viewer"];

/* Group permissions by their domain prefix (e.g., "products:view" → Products) */
const GROUPS: Array<{ key: string; permissions: Permission[] }> = [
  { key: "dashboard", permissions: ["dashboard:view"] },
  { key: "pos", permissions: ["pos:view", "pos:create_order", "pos:apply_discount", "pos:refund"] },
  { key: "products", permissions: ["products:view", "products:create", "products:edit", "products:delete"] },
  { key: "inventory", permissions: ["inventory:view", "inventory:adjust", "inventory:transfer"] },
  { key: "orders", permissions: ["orders:view", "orders:manage", "orders:refund"] },
  { key: "customers", permissions: ["customers:view", "customers:create", "customers:edit", "customers:delete"] },
  { key: "suppliers", permissions: ["suppliers:view", "suppliers:create", "suppliers:edit", "suppliers:delete"] },
  { key: "purchaseOrders", permissions: ["purchase_orders:view", "purchase_orders:create", "purchase_orders:confirm", "purchase_orders:receive", "purchase_orders:cancel"] },
  { key: "reports", permissions: ["reports:view", "reports:export"] },
  { key: "users", permissions: ["users:view", "users:create", "users:edit", "users:delete"] },
  { key: "settings", permissions: ["settings:view", "settings:edit"] },
];

export default function RolesSettingsPage() {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("roles.title")}
        description={t("roles.description")}
        breadcrumbs={[
          { label: t("settings.title"), href: "/settings" },
          { label: t("roles.breadcrumb") },
        ]}
      />

      {/* Role summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ROLES.map((role) => (
          <Card key={role} className="hover:shadow-md transition-shadow">
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-neu-primary">{ROLE_LABELS[role]}</p>
                <Badge variant={ROLE_COLORS[role] as "primary" | "success" | "danger" | "warning" | "info" | "default"} size="sm">
                  {ROLE_PERMISSIONS[role].length} {t("roles.permissions")}
                </Badge>
              </div>
              <p className="mt-1.5 text-xs text-neu-faint">{t(`roles.desc.${role}`)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Permission matrix */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neu-hairline bg-neu-sunken">
                <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider text-neu-faint">
                  {t("roles.permissionLabel")}
                </th>
                {ROLES.map((role) => (
                  <th key={role} className="px-3 py-3 text-center text-xs font-semibold text-neu-muted whitespace-nowrap">
                    {ROLE_LABELS[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neu-hairline">
              {GROUPS.map((group) => (
                <React.Fragment key={group.key}>
                  <tr className="bg-neu-sunken/60">
                    <td colSpan={ROLES.length + 1} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-neu-accent-ink-strong">
                      {t(`roles.group.${group.key}`)}
                    </td>
                  </tr>
                  {group.permissions.map((permission) => (
                    <tr key={permission} className="hover:bg-neu-sunken/50">
                      <td className="px-4 py-2.5 text-sm text-neu-primary">
                        {t(`roles.permission.${permission}`)}
                        {/* ms-2 is the same gap in both scripts: the chip trails its label, so the
                            space belongs on the start side. The old pair (ml-2 + rtl:ml-0 rtl:mr-2)
                            was a physical hand-roll of exactly that. */}
                        <span className={cn("ms-2 font-mono text-[10px] text-neu-faint")}>{permission}</span>
                      </td>
                      {ROLES.map((role) => {
                        const has = ROLE_PERMISSIONS[role].includes(permission);
                        return (
                          <td key={role} className="px-3 py-2.5 text-center">
                            {has ? (
                              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-neu-wash-green text-neu-ink-green">
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              </span>
                            ) : (
                              <span className={cn("text-neu-faint")}>—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
