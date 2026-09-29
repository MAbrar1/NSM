"use client";

import * as React from "react";
import { useI18n } from "@/components/providers/i18n-provider";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { readApiError } from "@/lib/api-error";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SortableTh } from "@/components/ui/sortable-th";
import { toast } from "@/stores/toast-store";
import { ROLE_LABELS, ROLE_COLORS, type Role } from "@/lib/rbac";

/* ═══════════════════════════════════════════════════════════════
   USERS MANAGEMENT PAGE
   Full CRUD for users with role management.
   ═══════════════════════════════════════════════════════════════ */

interface UserItem {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface UserForm {
  name: string;
  email: string;
  password: string;
  role: Role;
  isActive: boolean;
}

const EMPTY_FORM: UserForm = {
  name: "", email: "", password: "", role: "cashier", isActive: true,
};

const ROLE_OPTIONS: Role[] = ["admin", "manager", "cashier", "inventory_clerk", "viewer"];

export default function UsersPage() {
  const { t } = useI18n();
  const [users, setUsers] = React.useState<UserItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);

  // Server-side sort in the shared "field.order" wire format (the API
  // clamps it to its allow-list). Names read best A→Z; dates open
  // high→low. `status` sorts on the Boolean column (active first, then
  // inactive) rather than a meaningless string compare.
  const [sort, setSort] = React.useState("createdAt.desc");
  function toggleSort(field: string) {
    setSort((s) => {
      if (field === "status") return s === "isActive.asc" ? "isActive.desc" : "isActive.asc";
      if (s.startsWith(`${field}.`)) {
        return `${field}.${s.endsWith(".asc") ? "desc" : "asc"}`;
      }
      return `${field}.${field === "name" ? "asc" : "desc"}`;
    });
  }

  const [showForm, setShowForm] = React.useState(false);
  const [editing, setEditing] = React.useState<UserItem | null>(null);
  const [form, setForm] = React.useState<UserForm>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [deleting, setDeleting] = React.useState<UserItem | null>(null);

  function clearFieldError(field: string) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  const fetchUsers = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (search) params.set("search", search);
      if (roleFilter) params.set("role", roleFilter);
      params.set("sort", sort);
      const res = await fetch(`/api/users?${params}`);
      const data = await res.json();
      setUsers(data.users ?? []);
      setTotalPages(data.pagination?.totalPages ?? 1);
    } catch { setLoadError(true); }
    setLoading(false);
  }, [page, search, roleFilter, sort]);

  React.useEffect(() => { fetchUsers(); }, [fetchUsers]);
  React.useEffect(() => { const t = setTimeout(() => setPage(1), 300); return () => clearTimeout(t); }, [search, roleFilter]);
  React.useEffect(() => { setPage(1); }, [sort]);

  function openCreate() { setEditing(null); setForm(EMPTY_FORM); setFieldErrors({}); setShowForm(true); }
  function openEdit(u: UserItem) {
    setEditing(u);
    setForm({ name: u.name, email: u.email, password: "", role: u.role, isActive: u.isActive });
    setFieldErrors({});
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.email.trim()) return;
    if (!editing && !form.password) return;
    if (saving) return; // saving guard blocks double-submit
    setSaving(true);
    try {
      const url = editing ? `/api/users/${editing.id}` : "/api/users";
      const method = editing ? "PUT" : "POST";
      const body: Record<string, unknown> = {
        name: form.name,
        email: form.email,
        role: form.role,
        isActive: form.isActive,
      };
      if (form.password) body["password"] = form.password;
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        // Field-keyed errors underline the exact input; anything else
        // (permission denied, 500) is a single toast.
        const { fields, message } = await readApiError(res, t("common.saveFailed"));
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else toast.error(message);
        return;
      }
      setShowForm(false);
      fetchUsers();
      toast.success(editing ? t("users.updated") : t("users.created"));
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await fetch(`/api/users/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      fetchUsers();
      toast.success(t("users.deleted"));
    } catch { /* ignore */ }
  }

  function getInitials(name: string) {
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={t("users.title")}
        description={`${users.length} ${t("users.count")}`}
        breadcrumbs={[
          { label: t("dashboard.title"), href: "/dashboard" },
          { label: t("users.title") },
        ]}
        actions={
          <Button onClick={openCreate}>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("users.addUser")}
        </Button>
        }
      />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <svg className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("users.search")}
            className="h-10 w-full rounded-lg border border-neu-hairline bg-neu-bg ps-10 pe-4 text-sm text-neu-primary placeholder:text-neu-faint neu-focus" />
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
          className="h-10 rounded-lg border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-primary neu-focus">
          <option value="">{t("common.all")} {t("users.role")}</option>
          {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-neu-hairline bg-neu-bg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neu-hairline bg-neu-sunken">
                <SortableTh label={t("users.name")} active={sort.startsWith("name.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("name")} />
                <th className="text-start px-4 py-3 font-medium text-neu-muted hidden md:table-cell">{t("users.email")}</th>
                <th className="text-center px-4 py-3 font-medium text-neu-muted">{t("users.role")}</th>
                <SortableTh label={t("users.status")} align="center" active={sort.startsWith("isActive.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("status")} />
                <SortableTh label={t("users.lastLogin")} className="hidden lg:table-cell" active={sort.startsWith("lastLoginAt.")} order={sort.endsWith(".asc") ? "asc" : "desc"} onClick={() => toggleSort("lastLoginAt")} />
                <th className="text-end px-4 py-3 font-medium text-neu-muted">{t("products.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neu-hairline">
              {loading ? (
                <TableSkeleton rows={5} />
              ) : loadError ? (
                <tr>
                  <td colSpan={6} className="px-4 py-0">
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
                        <Button variant="secondary" size="sm" onClick={fetchUsers}>
                          {t("common.retry")}
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-0">
                    <EmptyState
                      bare
                      icon={
                        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                        </svg>
                      }
                      title={t("users.noUsers")}
                      description={search || roleFilter ? t("users.noUsersHintFilter") : t("users.noUsersHint")}
                    />
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="hover:bg-neu-sunken transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neu-accent-wash text-sm font-semibold text-neu-accent-ink-strong">
                          {getInitials(u.name)}
                        </div>
                        <div>
                          <p className="font-medium text-neu-primary">{u.name}</p>
                          <p className="text-xs text-neu-faint md:hidden">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-neu-muted hidden md:table-cell">{u.email}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={ROLE_COLORS[u.role] as "danger" | "primary" | "success" | "info" | "warning" | "default"}>
                        {ROLE_LABELS[u.role]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={u.isActive ? "success" : "danger"}>
                        {u.isActive ? t("products.active") : t("products.inactive")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-neu-faint hidden lg:table-cell">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(u)} title={t("common.edit")}>
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                          </svg>
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(u)} title={t("common.delete")} className="text-neu-ink-red hover:bg-neu-wash-red">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                          </svg>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-neu-hairline px-4 py-3">
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("common.previous")}</Button>
            <span className="text-sm text-neu-faint">{t("common.page")} {page} {t("common.of")} {totalPages}</span>
            <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{t("common.next")}</Button>
          </div>
        )}
      </div>

      {/* ═══ CREATE/EDIT MODAL ═══ */}
      <Dialog open={showForm} onOpenChange={(o) => !o && setShowForm(false)}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader>
              <DialogTitle>{editing ? t("users.editUser") : t("users.addUser")}</DialogTitle>
              <DialogClose asChild>
                <button aria-label={t("common.close")} className="rounded-lg p-1 text-neu-faint hover:bg-neu-sunken">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </DialogClose>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <Input
                label={`${t("users.name")} *`}
                value={form.name}
                error={fieldErrors["name"]}
                onChange={(e) => { setForm({ ...form, name: e.target.value }); clearFieldError("name"); }}
              />
              <Input
                label={`${t("users.email")} *`}
                type="email"
                value={form.email}
                error={fieldErrors["email"]}
                onChange={(e) => { setForm({ ...form, email: e.target.value }); clearFieldError("email"); }}
              />
              <Input
                label={`${t("users.password")} ${editing ? `(${t("users.passwordKeep")})` : "*"}`}
                type="password"
                value={form.password}
                error={fieldErrors["password"]}
                onChange={(e) => { setForm({ ...form, password: e.target.value }); clearFieldError("password"); }}
              />
              <div>
                <label className="block text-sm font-medium text-neu-primary mb-1">{t("users.role")}</label>
                <select
                  value={form.role}
                  onChange={(e) => { setForm({ ...form, role: e.target.value as Role }); clearFieldError("role"); }}
                  className={`h-10 w-full rounded-lg border bg-neu-bg px-3 text-sm neu-focus ${fieldErrors["role"] ? "border-neu-ink-red" : "border-neu-hairline"}`}
                >
                  {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
                {fieldErrors["role"] && <p className="mt-1 text-xs text-neu-ink-red">{fieldErrors["role"]}</p>}
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-neu-primary">{t("users.status")}</label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.isActive}
                  onClick={() => setForm({ ...form, isActive: !form.isActive })}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${form.isActive ? "bg-neu-solid-green" : "bg-neu-sunken"}`}
                >
                  {/* logical knob: rtl:-translate mirrors with the layout, and
                      the MODE-STABLE solid tokens keep contrast in both themes
                      (bg-neu-green/solid-ink knob was dark-mode broken). */}
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-neu-bg shadow transition-transform ${form.isActive ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1"}`} />
                </button>
                <span className="text-sm text-neu-muted">{form.isActive ? t("products.active") : t("products.inactive")}</span>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setShowForm(false)}>{t("common.cancel")}</Button>
              <Button type="submit" loading={saving}>{t("common.save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ═══ DELETE CONFIRM ═══ */}
      <Dialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent size="sm">
          <DialogBody className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neu-red/15">
              <svg className="h-6 w-6 text-neu-ink-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold">{t("common.delete")} {deleting?.name}?</h3>
            <p className="text-sm text-neu-faint">{t("users.deleteHint")}</p>
          </DialogBody>
          <DialogFooter className="gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" className="flex-1" onClick={handleDelete}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
