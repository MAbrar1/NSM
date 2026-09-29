"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { cn, getInitials } from "@/lib/utils";
import { useUIStore } from "@/stores/ui-store";
import { useWarehouseStore } from "@/stores/warehouse-store";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { usePopoverMenu } from "@/hooks/use-popover-menu";
import { useI18n } from "@/components/providers/i18n-provider";
import { CurrencySync } from "@/components/providers/currency-provider";
import { ThemeToggle } from "@/components/providers/theme-provider";
import { CurrencyPicker } from "@/components/providers/currency-picker";
import { Toaster } from "@/components/ui/toaster";
import { PrintPreviewProvider } from "@/components/print/print-preview";
import { LiveClock } from "@/components/layout/live-clock";
import { SyncIndicator } from "@/components/layout/sync-indicator";
import { WelcomeModal } from "@/components/layout/welcome-modal";
import { NAVIGATION, APP_NAME, APP_VERSION, type NavItem } from "@/lib/constants";
import { ROLE_LABELS, canAccessRoute, type Role } from "@/lib/rbac";
import { NotificationBell } from "@/components/layout/notification-bell";

/* ─── Header helpers ─── */

const ROLE_BADGE: Record<string, string> = {
  super_admin: "bg-neu-wash-red text-neu-ink-red border-neu-ink-red/20",
  admin: "bg-neu-accent-wash text-neu-accent-ink-strong border-neu-accent-line",
  manager: "bg-neu-wash-green text-neu-ink-green border-neu-ink-green/20",
  cashier: "bg-neu-wash-cyan text-neu-ink-cyan border-neu-ink-cyan/20",
  inventory_clerk: "bg-neu-wash-amber text-neu-ink-amber border-neu-ink-amber/20",
  viewer: "bg-neu-sunken text-neu-primary border-neu-hairline",
};

/* ─── Page context ───
   The rail answers "where can I go"; the bar answers "where am I". Both read
   the SAME `NAVIGATION` map, so the highlight in the rail and the label in the
   bar can never disagree about what a route is called.

   Exact hits win over prefix hits, so a nested route that is itself in the map
   (`/settings/audit-log`) is not reported as its parent. A route that is not in
   the map at all — a detail page such as `/orders/<id>` — shows its parent's
   name rather than the raw id, and anything else falls back to its own path
   segment, humanized. */

function humanizeSegment(segment: string): string {
  if (!segment) return APP_NAME;
  const words = segment.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pageContextFor(
  pathname: string | null,
  t: (key: string) => string
): { section: string | null; title: string } {
  const groups: Array<{ title: string | null; items: NavItem[] }> = [
    { title: null, items: NAVIGATION.MAIN },
    { title: t("nav.reportsLabel"), items: NAVIGATION.REPORTS },
    { title: t("nav.settingsLabel"), items: NAVIGATION.SETTINGS },
  ];
  const label = (item: NavItem) => (item.i18n ? t(item.i18n) : item.label);
  const path = pathname ?? "";

  for (const group of groups) {
    const hit = group.items.find((item) => item.href === path);
    if (hit) return { section: group.title, title: label(hit) };
  }

  const leaf = path.split("/").filter(Boolean).pop() ?? "";
  const looksLikeAnId = /^\d+$/.test(leaf) || /^[0-9a-f-]{8,}$/i.test(leaf);
  for (const group of groups) {
    const parent = group.items.find((item) => path.startsWith(item.href + "/"));
    if (parent)
      return { section: group.title, title: looksLikeAnId ? label(parent) : humanizeSegment(leaf) };
  }
  return { section: null, title: humanizeSegment(leaf) };
}

/* ─── Nav rows ───
   One row definition for six lists (three groups × the desktop rail and the
   mobile drawer). The row is flat on the surface at rest, recessed tint on
   hover, and the CURRENT page wears the accent wash plus the inset emboss and
   an accent edge bar.

   `aria-current="page"` is not decoration: it is the only thing that tells a
   screen reader which link is the current page. Before this, the sidebar
   communicated that with colour alone. */

const NAV_ROW =
  "relative flex items-center gap-3 rounded-[var(--neu-radius-sm)] px-3 py-2.5 text-sm transition-colors duration-150 neu-focus";
const NAV_ROW_IDLE = "font-medium text-neu-muted hover:bg-neu-sunken hover:text-neu-primary";
const NAV_ROW_ACTIVE = "neu-inset-sm bg-neu-accent-wash font-semibold text-neu-accent-ink-strong";

function NavGroup({
  title,
  items,
  collapsed = false,
  isActive,
  canView,
  label,
  onNavigate,
}: {
  title?: string;
  items: NavItem[];
  collapsed?: boolean;
  isActive: (href: string) => boolean;
  canView: (href: string) => boolean;
  label: (item: NavItem) => string;
  onNavigate?: () => void;
}) {
  const visible = items.filter((item) => canView(item.href));
  if (visible.length === 0) return null;
  return (
    <div className="space-y-1">
      {/* Below `lg` the rail is forced into its icon form whatever the user's
          preference is (see `sidebarWidth`), so every label-bearing piece of
          a row is hidden there and a group becomes a plain divider. That is
          the difference between "collapsed because you asked" and "collapsed
          because there is no room": both must look deliberate. */}
      {title && !collapsed && (
        <div className="flex items-center gap-2 px-3 pb-1 pt-5 max-lg:hidden">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-neu-faint">
            {title}
          </span>
          <span aria-hidden className="h-px flex-1 bg-neu-hairline" />
        </div>
      )}
      {title && collapsed && <span aria-hidden className="mx-3 my-2 block h-px bg-neu-hairline" />}
      {visible.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            title={collapsed ? label(item) : undefined}
            className={cn(
              NAV_ROW,
              active ? NAV_ROW_ACTIVE : NAV_ROW_IDLE,
              collapsed ? "justify-center px-2" : "max-lg:justify-center max-lg:px-2"
            )}
          >
            {active && (
              <span
                aria-hidden
                className="absolute start-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-neu-accent-line"
              />
            )}
            <NavIcon name={item.icon} isActive={active} />
            {collapsed ? null : <span className="truncate max-lg:hidden">{label(item)}</span>}
          </Link>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD LAYOUT
   Fully responsive shell with:
   - Mobile: slide-over sidebar with overlay
   - Desktop: collapsible sidebar
   - Sticky header with warehouse selector
   ═══════════════════════════════════════════════════════════════ */

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale, setLocale } = useI18n();
  const { sidebarCollapsed, toggleSidebar, sidebarMobileOpen, setSidebarMobileOpen } = useUIStore();
  const { warehouses, selectedWarehouseId, setWarehouses, selectWarehouse } = useWarehouseStore();
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<
    Record<
      string,
      Array<{
        type: string;
        id: string;
        title: string;
        subtitle: string;
        href: string;
        badge?: string;
        badgeVariant?: string;
      }>
    >
  >({});
  const [searching, setSearching] = React.useState(false);
  // Is there content under the bar yet? (Drives its lifted shadow.)
  const [scrolled, setScrolled] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // Session + account menu. The notification bell owns its own feed, scope
  // and read state (components/layout/notification-bell.tsx), so the shell
  // no longer polls /api/alerts or holds notif state at all.
  const { data: session } = useSession();
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const userMenuRef = React.useRef<HTMLDivElement>(null);
  const userTriggerRef = React.useRef<HTMLButtonElement>(null);
  const userPanelRef = React.useRef<HTMLDivElement>(null);
  const mobileDrawerRef = React.useRef<HTMLElement>(null);
  const searchPanelRef = React.useRef<HTMLDivElement>(null);
  const helpPanelRef = React.useRef<HTMLDivElement>(null);

  // Close the account menu on outside click. (The bell handles its own.)
  React.useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  // Load warehouses (retry on transient dev-compile 500s so the header
  // selector and per-warehouse dashboard scope stay reliable)
  React.useEffect(() => {
    let cancelled = false;
    const load = async (attempt: number): Promise<void> => {
      try {
        const r = await fetch("/api/warehouses");
        if (!r.ok) throw new Error(`status ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        const whs = (d.warehouses ?? []).map(
          (w: { id: string; name: string; code: string; isDefault: boolean }) => ({
            id: w.id,
            name: w.name,
            code: w.code,
            isDefault: w.isDefault,
          })
        );
        setWarehouses(whs);
      } catch {
        if (!cancelled && attempt < 4)
          setTimeout(() => void load(attempt + 1), 1500 * (attempt + 1));
      }
    };
    void load(0);
    return () => {
      cancelled = true;
    };
  }, [setWarehouses]);

  // Global keyboard shortcuts
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setHelpOpen(false);
        setSidebarMobileOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setSidebarMobileOpen]);

  // Focus search input
  React.useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  // Every overlay this layout hand-rolls announces itself as a modal
  // (`role="dialog" aria-modal="true"`), so all three have to honour the
  // modal keyboard contract: focus in on open, Tab trapped inside while it is
  // open, focus handed back to the opener on close. One hook, applied at the
  // same place the role is applied, so the announcement and the behaviour
  // cannot drift apart.
  useModalFocus(sidebarMobileOpen, mobileDrawerRef);
  useModalFocus(searchOpen, searchPanelRef);
  useModalFocus(helpOpen, helpPanelRef);

  // The header's two dropdowns are `role="menu"`, so they owe the menu
  // keyboard contract too: arrows to walk the items, Escape to close and hand
  // focus back to the bell / avatar. They previously had neither.
  usePopoverMenu({
    open: userMenuOpen,
    triggerRef: userTriggerRef,
    panelRef: userPanelRef,
    onClose: () => setUserMenuOpen(false),
  });

  // Debounced global search
  React.useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults({});
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&limit=15`);
        const data = await res.json();
        setSearchResults(data.groups ?? {});
      } catch {
        setSearchResults({});
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/products?search=${encodeURIComponent(searchQuery.trim())}`);
      setSearchOpen(false);
      setSearchQuery("");
      setSearchResults({});
    }
  }

  function navigateToResult(href: string) {
    router.push(href);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults({});
  }

  const totalResults = Object.values(searchResults).reduce((s, arr) => s + arr.length, 0);

  // Only show nav links the signed-in role is allowed to access
  const role = session?.user?.role as Role | undefined;
  const canView = (href: string) => (role ? canAccessRoute(role, href) : true);

  // Where am I — resolved from the same map the rail is drawn from.
  const pageContext = React.useMemo(() => pageContextFor(pathname, t), [pathname, t]);

  // ── Command palette: quick actions (role-gated) ─────────────────
  const [activeIndex, setActiveIndex] = React.useState(-1);

  const quickActions = [
    {
      label: t("palette.newSale"),
      href: "/pos",
      icon: "M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z",
    },
    {
      label: t("palette.addProduct"),
      href: "/products?new=1",
      icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    },
    {
      label: t("palette.newCustomer"),
      href: "/customers?new=1",
      icon: "M15 9h3.75M15 12h3.75M15 15h3.75M4.5 19.5h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5zm6-10.125a1.875 1.875 0 11-3.75 0 1.875 1.875 0 013.75 0zm1.294 6.336a6.721 6.721 0 01-3.17.789 6.721 6.721 0 01-3.168-.789 3.376 3.376 0 016.338-2.0z",
    },
    {
      label: t("palette.receivePayment"),
      href: "/customers?tab=dues",
      icon: "M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    },
    {
      label: t("palette.newPO"),
      href: "/purchase-orders?new=1",
      icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
    },
    {
      label: t("palette.salesReport"),
      href: "/reports/sales",
      icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
    },
  ].filter((a) => canView(a.href));

  // Flat keyboard-navigable index: quick actions first, then search results.
  const flatResults = React.useMemo(() => {
    const actions = quickActions.map((a) => ({ kind: "action" as const, ...a }));
    const entities = Object.entries(searchResults).flatMap(([type, items]) =>
      (
        items as Array<{
          id: string;
          href: string;
          title: string;
          subtitle: string;
          badge?: string;
          badgeVariant?: string;
        }>
      ).map((it) => ({
        kind: "result" as const,
        type,
        id: it.id,
        href: it.href,
        title: it.title,
        subtitle: it.subtitle,
        badge: it.badge,
        badgeVariant: it.badgeVariant,
      }))
    );
    return [...actions, ...entities];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchResults, role]);

  // ↑/↓/Enter navigation over the flat result list.
  React.useEffect(() => {
    setActiveIndex(-1);
  }, [searchQuery]);
  React.useEffect(() => {
    if (!searchOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatResults.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, -1));
      } else if (e.key === "Enter" && !e.ctrlKey) {
        const item = flatResults[activeIndex];
        if (item) {
          e.preventDefault();
          navigateToResult(item.href);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, flatResults, activeIndex]);

  /* The rail is 72px — icon form — at every width below `lg`, and only then
     does the user's preference decide. Two reasons, both measured: below `lg`
     there is no room for a 260px rail and a usable bar (at 768 it left the
     header 508px for a 679px control cluster, i.e. a clipped bar), and a
     tablet is a touch device where a labelled rail is a luxury. */
  const sidebarWidth = sidebarCollapsed ? "w-[72px]" : "w-[72px] lg:w-[260px]";

  return (
    <div className="flex h-dvh overflow-hidden bg-neu-sunken">
      {/* ═══ SKIP LINK ═══
          A shell with a rail and 12–24 chrome controls before the content
          costs a keyboard user 20+ Tabs on every navigation. It is the first
          thing in the tab order, invisible until it is focused, and it targets
          a `main` that is programmatically focusable for exactly this. */}
      <a
        href="#main-content"
        className="neu-btn neu-btn-sm neu-focus absolute start-3 top-3 z-[var(--z-modal)] sr-only focus:not-sr-only"
      >
        {t("common.skipToContent")}
      </a>

      {/* ═══ GOLDEN GRAIN ═══
          A near-invisible noise layer that keeps the gold gradients from
          banding on wide monitors. It carries no content, is scoped to
          `html.golden` in CSS (so it never renders in Neu light/dark), and
          is switched off under prefers-reduced-motion and prefers-contrast.
          Purely decorative, hence aria-hidden. */}
      <div aria-hidden className="golden-grains" />

      {/* ═══ MOBILE OVERLAY ═══ */}
      {sidebarMobileOpen && (
        <div
          className="fixed inset-0 z-[var(--z-overlay)] neu-dialog-overlay transition-opacity md:hidden"
          onClick={() => setSidebarMobileOpen(false)}
        />
      )}

      {/* ═══ SIDEBAR ═══ */}
      <aside
        className={cn(
          // `start-0`, not `left-0`: this is the mobile/overlay form of the
          // rail, and in RTL (Urdu) the shell's leading edge is the RIGHT one.
          "fixed inset-y-0 start-0 z-[var(--z-sidebar)] flex flex-col",
          "bg-neu-bg",
          "transition-all duration-300 ease-smooth",
          // Desktop. The rail's children stay full-width and centre their OWN
          // contents (`justify-center` on the row, the button and the identity
          // block): centring them as flex ITEMS instead shrinks each wrapper to
          // its content, which made the primary action a 16px pill instead of
          // the 48px one the other collapsed rows are.
          "hidden md:flex md:relative",
          sidebarWidth
        )}
      >
        <span aria-hidden className="neu-separator-v absolute inset-y-0 end-0" />
        {/* Logo — the brand mark sits in a recessed socket instead of on a
            drop shadow. The mark keeps the solid accent (the one place a vivid
            fill belongs); the depth around it is the system's emboss. */}
        <div
          className={cn(
            "flex h-16 shrink-0 items-center border-b border-neu-hairline",
            sidebarCollapsed
              ? "justify-center px-2"
              : "gap-3 px-5 max-lg:justify-center max-lg:px-2"
          )}
        >
          <span className="neu-inset-sm flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--neu-radius-sm)] p-[5px]">
            <span className="flex h-full w-full items-center justify-center rounded-lg bg-neu-accent-solid text-neu-solid-ink">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                />
              </svg>
            </span>
          </span>
          {!sidebarCollapsed && (
            <span className="truncate text-lg font-bold tracking-tight text-neu-primary max-lg:hidden">
              {APP_NAME}
            </span>
          )}
        </div>

        {/* The one action a POS shell should never make you hunt for: the
            rail's first control is the thing a cashier does all day. */}
        {canView("/pos") && (
          <div className="shrink-0 px-3 pt-3">
            <Link
              href="/pos"
              title={sidebarCollapsed ? t("palette.newSale") : undefined}
              className={cn(
                // The one filled control in the shell: the logo carries the
                // brand, this carries the primary action. `--neu-solid-ink` on
                // `--neu-accent-solid` is the pair the audit already proves at
                // >= 4.5:1 in both modes.
                "neu-btn neu-btn-sm neu-focus w-full bg-neu-accent-solid font-semibold text-neu-solid-ink",
                sidebarCollapsed
                  ? "justify-center px-0"
                  : "justify-start gap-2 max-lg:justify-center max-lg:px-0"
              )}
            >
              <svg
                className="h-4 w-4 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.25}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              {/* Hidden when the rail is icon-only — the same rule the nav
                  rows follow. Without the `collapsed` guard the full label
                  rendered inside the 72px rail and clipped against the icon. */}
              {!sidebarCollapsed && <span className="truncate max-lg:hidden">{t("palette.newSale")}</span>}
            </Link>
          </div>
        )}

        {/* Navigation — a labelled landmark. Two <nav> elements exist (rail and
            drawer); without a name they are indistinguishable in a landmark
            list, which is exactly how a screen-reader user navigates a shell. */}
        <nav
          aria-label={t("nav.primary")}
          className="flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 py-4"
        >
          <NavGroup
            items={NAVIGATION.MAIN}
            collapsed={sidebarCollapsed}
            canView={canView}
            isActive={(href) => pathname === href || !!pathname?.startsWith(href + "/")}
            label={(item) => (item.i18n ? t(item.i18n) : item.label)}
          />
          <NavGroup
            title={t("nav.reportsLabel")}
            items={NAVIGATION.REPORTS}
            collapsed={sidebarCollapsed}
            canView={canView}
            isActive={(href) => pathname === href}
            label={(item) => (item.i18n ? t(item.i18n) : item.label)}
          />
          <NavGroup
            title={t("nav.settingsLabel")}
            items={NAVIGATION.SETTINGS}
            collapsed={sidebarCollapsed}
            canView={canView}
            isActive={(href) => pathname === href || !!pathname?.startsWith(href + "/")}
            label={(item) => (item.i18n ? t(item.i18n) : item.label)}
          />
        </nav>

        {/* Who is signed in. The rail is the app's identity column, and until
            now the signed-in user existed only behind the avatar menu — the
            role chip in particular is the thing a cashier is told to check
            when a control they expect is missing. Recessed, like every other
            static chip in the system. */}
        {session?.user && (
          <div className="border-t border-neu-hairline p-3">
            <div
              className={cn(
                "flex items-center gap-3 px-2 py-1",
                sidebarCollapsed ? "justify-center px-0" : "max-lg:justify-center max-lg:px-0"
              )}
              title={sidebarCollapsed ? (session.user.name ?? undefined) : undefined}
            >
              <span
                aria-hidden
                className="neu-inset-sm flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neu-accent-wash text-[11px] font-bold text-neu-accent-ink-strong"
              >
                {session.user.name ? getInitials(session.user.name) : "U"}
              </span>
              {!sidebarCollapsed && (
                <span className="min-w-0 flex-1 max-lg:hidden">
                  <span className="block truncate text-sm font-semibold text-neu-primary">
                    {session.user.name ?? "User"}
                  </span>
                  {session.user.role && (
                    <span
                      className={cn(
                        "mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                        ROLE_BADGE[session.user.role] ?? ""
                      )}
                    >
                      {ROLE_LABELS[session.user.role as keyof typeof ROLE_LABELS] ??
                        session.user.role}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Collapse toggle — a raised chip rather than a bare text row, so
            the rail's only control reads as a control. When the rail is
            collapsed the visible text is gone, so the control has to name the
            action it will perform from its own attributes. */}
        {/* No toggle below `lg`: the rail is icon-only there by rule, not by
            preference, so a control that cannot change anything is noise. */}
        <div className="hidden border-t border-neu-hairline p-3 lg:block">
          <button
            onClick={toggleSidebar}
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? t("nav.expand") : t("nav.collapse")}
            title={sidebarCollapsed ? t("nav.expand") : t("nav.collapse")}
            className={cn(
              "flex w-full items-center gap-3 rounded-[var(--neu-radius-sm)] px-3 py-2.5 text-sm font-medium neu-focus",
              "text-neu-faint transition-colors hover:bg-neu-sunken hover:text-neu-primary",
              sidebarCollapsed && "justify-center px-2"
            )}
          >
            <span className="neu-raised-sm flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
              <svg
                className={cn(
                  "h-4 w-4 transition-transform duration-300",
                  sidebarCollapsed && "rotate-180"
                )}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                />
              </svg>
            </span>
            {!sidebarCollapsed && <span className="max-lg:hidden">{t("nav.collapse")}</span>}
          </button>
        </div>

        {/* Version, not decoration: this is the one line support asks for, and
            it belongs in the chrome rather than behind a menu. */}
        <div className="hidden shrink-0 border-t border-neu-hairline px-3 py-2 lg:block">
          <p
            className={cn(
              "text-[10px] font-medium tracking-tight text-neu-faint",
              sidebarCollapsed && "text-center"
            )}
          >
            {APP_NAME} v{APP_VERSION}
          </p>
        </div>
      </aside>

      {/* ═══ MOBILE SIDEBAR ═══
          Stays mounted at all times: the slide-in is a `translate`, and
          unmounting would kill the transition. That is exactly why it must
          not keep `role="dialog" aria-modal="true"` while CLOSED — a
          permanently "open" modal that is only translated off-screen tells
          assistive tech the page behind it is inert forever, and leaves
          every nav link tabbable. Closed ⇒ inert + aria-hidden, no role. */}
      <aside
        ref={mobileDrawerRef}
        role={sidebarMobileOpen ? "dialog" : undefined}
        aria-modal={sidebarMobileOpen ? true : undefined}
        aria-hidden={!sidebarMobileOpen}
        inert={!sidebarMobileOpen}
        aria-label={t("nav.menu")}
        className={cn(
          "fixed inset-y-0 start-0 z-[var(--z-sidebar)] flex w-[280px] flex-col",
          "bg-neu-bg",
          "transition-transform duration-300 ease-smooth md:hidden",
          // The closed drawer is pushed OFF the leading edge, and "off" is the
          // opposite direction in RTL. Without the `rtl:` twin the closed
          // drawer sat ON the content in Urdu — a full-height overlay nobody
          // had opened.
          sidebarMobileOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"
        )}
      >
        {/* Embossed edge instead of a 1px rule: the dark line over a light
            one is the same separator the rest of the app draws. */}
        <span aria-hidden className="neu-separator-v absolute inset-y-0 end-0" />
        <div className="flex h-16 items-center justify-between border-b border-neu-hairline px-4">
          <div className="flex items-center gap-3">
            <span className="neu-inset-sm flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--neu-radius-sm)] p-[5px]">
              <span className="flex h-full w-full items-center justify-center rounded-lg bg-neu-accent-solid text-neu-solid-ink">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                  />
                </svg>
              </span>
            </span>
            <span className="truncate text-lg font-bold tracking-tight text-neu-primary">
              {APP_NAME}
            </span>
          </div>
          {/* Icon-only, so it needs a real accessible name — it had none. */}
          <button
            onClick={() => setSidebarMobileOpen(false)}
            aria-label={t("common.close")}
            title={t("common.close")}
            className="neu-btn neu-btn-icon-sm neu-focus text-neu-muted hover:bg-neu-sunken hover:text-neu-primary"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <nav
          aria-label={t("nav.menu")}
          className="flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 py-4"
        >
          <NavGroup
            items={NAVIGATION.MAIN}
            canView={canView}
            isActive={(href) => pathname === href || !!pathname?.startsWith(href + "/")}
            label={(item) => (item.i18n ? t(item.i18n) : item.label)}
            onNavigate={() => setSidebarMobileOpen(false)}
          />
          <NavGroup
            title={t("nav.reportsLabel")}
            items={NAVIGATION.REPORTS}
            canView={canView}
            isActive={(href) => pathname === href}
            label={(item) => (item.i18n ? t(item.i18n) : item.label)}
            onNavigate={() => setSidebarMobileOpen(false)}
          />
          <NavGroup
            title={t("nav.settingsLabel")}
            items={NAVIGATION.SETTINGS}
            canView={canView}
            isActive={(href) => pathname === href || !!pathname?.startsWith(href + "/")}
            label={(item) => (item.i18n ? t(item.i18n) : item.label)}
            onNavigate={() => setSidebarMobileOpen(false)}
          />
        </nav>
      </aside>

      {/* ═══ MAIN CONTENT ═══ */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        {/* Header */}
        {/* The bar shares the page surface and separates itself with the same
            two-line emboss the rest of the app draws; the depth in it comes
            from the controls, which are raised (chips) or recessed (wells). */}
        {/* ── The bar's degradation ladder ──
            Everything on the right cannot fit at every width, and the widest
            band is the tightest: at 768–1023 the rail takes 260px of a 768px
            screen, so the bar has 508px for a cluster that is 679px wide at
            full size. Measured, not guessed — the pages audit asserts that the
            header fits at 375, 768, 1024 and 1440, which is how the clipped
            controls at tablet width were found.

            The rail is icon-only below `lg` (see `sidebarWidth`), which is what
            buys the 188px that lets every control in the cluster stay visible
            there; below `lg` the wide search well becomes a 34px icon button,
            so the palette stays reachable on touch at every width, and the
            clock swaps its full readout for a compact one below `xl`. */}
        <header
          className={cn(
            "relative flex h-16 shrink-0 items-center gap-2 bg-neu-bg px-4 lg:gap-3 lg:px-6",
            // Once there is content under the bar, the bar lifts: a downward
            // shadow only, because a bar is a lid, not a floating card. At rest
            // it is flush with the page, which is the whole point of the
            // two-line separator it already draws.
            scrolled && "neu-bar-lifted"
          )}
        >
          <span aria-hidden className="neu-separator-h absolute inset-x-0 bottom-0" />
          {/* Mobile menu */}
          <button
            onClick={() => setSidebarMobileOpen(true)}
            aria-label={t("nav.menu")}
            aria-expanded={sidebarMobileOpen}
            className="neu-btn neu-btn-icon-sm neu-focus text-neu-muted hover:bg-neu-sunken hover:text-neu-primary md:hidden"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Where am I. Section + page in words, in the same ink ladder the
              rest of the chrome uses. A plain span, deliberately not an <h1>:
              every page already renders its own heading, and a second one here
              would add a phantom stop to heading navigation. */}
          <div className="hidden min-w-0 items-baseline gap-2 xl:flex">
            {pageContext.section && (
              <>
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-neu-faint">
                  {pageContext.section}
                </span>
                <span aria-hidden className="h-3.5 w-px shrink-0 self-center bg-neu-hairline" />
              </>
            )}
            <span className="truncate text-sm font-semibold text-neu-primary">
              {pageContext.title}
            </span>
          </div>

          {/* Search (desktop) — a recessed well, like every text field in the
              system, with the shortcut as a small raised keycap inside it. */}
          <button
            onClick={() => setSearchOpen(true)}
            className="neu-inset-sm neu-focus hidden h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-[var(--neu-radius-md)] bg-neu-sunken px-3 text-sm text-neu-faint transition-colors hover:bg-neu-bg hover:text-neu-muted lg:flex"
          >
            <svg
              className="h-4 w-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <span className="flex-1 truncate text-start">{t("header.searchPlaceholder")}</span>
            <kbd className="neu-raised-sm rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium text-neu-faint">
              ⌘K
            </kbd>
          </button>

          {/* Search (compact) — replaces the well below `lg`, which is where
              the palette previously had no entry point at all: on a handset or
              a tablet it was reachable only with a physical keyboard.
              Icon-only, so it carries a real name. */}
          <button
            onClick={() => setSearchOpen(true)}
            aria-label={t("common.search")}
            title={t("common.search")}
            className="neu-btn neu-btn-icon-sm neu-focus text-neu-muted hover:bg-neu-sunken hover:text-neu-primary lg:hidden"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </button>

          {/* Right side — pushed to the end by its own margin, so the left
              cluster can grow into whatever width is left without the bar
              depending on `justify-between` to place three groups. */}
          <div className="ms-auto flex shrink-0 items-center gap-1.5 lg:gap-2">
            {/* Warehouse selector */}
            {warehouses.length > 1 && (
              <select
                className="neu-inset-sm neu-focus hidden h-9 max-w-[8.5rem] items-center gap-2 truncate rounded-[var(--neu-radius-sm)] border border-neu-hairline bg-neu-bg px-3 text-sm text-neu-muted transition-colors sm:flex"
                value={selectedWarehouseId ?? ""}
                onChange={(e) => selectWarehouse(e.target.value)}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}

            {/* Live clock */}
            <LiveClock />

            {/* Language toggle */}
            <button
              onClick={() => setLocale(locale === "en" ? "ur" : "en")}
              aria-label={t("common.language")}
              className="neu-btn neu-btn-sm neu-focus px-3 font-medium text-neu-muted hover:bg-neu-sunken hover:text-neu-primary"
              title={t("common.language")}
            >
              {locale === "en" ? "اردو" : "EN"}
            </button>

            {/* Theme toggle */}
            <ThemeToggle />

            {/* Display-currency picker (per-browser, live-converted) */}
            <CurrencyPicker />

            {/* Help button */}
            <button
              onClick={() => setHelpOpen(true)}
              // Icon-only, so it needs a real accessible name: `title` alone
              // is only a last-resort fallback for assistive tech.
              aria-label={t("header.shortcuts")}
              title={t("header.shortcuts")}
              // Visible on phones-with-a-keyboard and on real desktops, hidden
              // in the one band where the bar has the least room per control.
              className="neu-btn neu-btn-icon-sm neu-focus hidden text-neu-muted hover:bg-neu-sunken hover:text-neu-primary sm:flex"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                />
              </svg>
            </button>

            {/* Notification bell — self-contained feed + read state. */}
            <NotificationBell />

            {/* User menu */}
            <div className="relative" ref={userMenuRef}>
              <button
                ref={userTriggerRef}
                onClick={() => setUserMenuOpen((v) => !v)}
                className={cn(
                  "neu-btn neu-btn-icon-sm neu-focus rounded-full",
                  userMenuOpen
                    ? "bg-neu-sunken text-neu-primary"
                    : "text-neu-muted hover:bg-neu-sunken hover:text-neu-primary"
                )}
                title={t("header.account")}
                aria-label={t("header.account")}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neu-accent-solid text-xs font-bold text-neu-solid-ink">
                  {session?.user?.name ? getInitials(session.user.name) : "U"}
                </div>
              </button>

              {userMenuOpen && (
                <div
                  ref={userPanelRef}
                  role="menu"
                  aria-label={t("header.account")}
                  className="neu-elevated absolute end-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-neu-hairline animate-scale-in"
                >
                  <div className="border-b border-neu-hairline px-4 py-3">
                    <p className="truncate text-sm font-semibold text-neu-primary">
                      {session?.user?.name ?? "User"}
                    </p>
                    <p className="truncate text-xs text-neu-faint">{session?.user?.email}</p>
                    {session?.user?.role && (
                      <span
                        className={cn(
                          "mt-1.5 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                          ROLE_BADGE[session.user.role] ?? ""
                        )}
                      >
                        {ROLE_LABELS[session.user.role as keyof typeof ROLE_LABELS] ??
                          session.user.role}
                      </span>
                    )}
                  </div>
                  <div className="p-1.5">
                    <a
                      role="menuitem"
                      href="/dashboard"
                      onClick={() => setUserMenuOpen(false)}
                      className="neu-focus flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neu-muted transition-colors hover:bg-neu-sunken hover:text-neu-primary"
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.75}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75"
                        />
                      </svg>
                      {t("header.dashboard")}
                    </a>
                    <button
                      role="menuitem"
                      onClick={() => signOut({ callbackUrl: "/login" })}
                      className="neu-focus flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neu-ink-red transition-colors hover:bg-neu-wash-red"
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.75}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"
                        />
                      </svg>
                      {t("header.signOut")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content. The rail's width is real estate the content can use:
            collapsed, it gives back 188px, and the measure widens with it so
            tables and dashboards actually fill the room instead of stopping at
            the same 1280px and centring in it. The narrower cap still applies
            while the rail is open, because an uncapped table on a 2560px
            monitor is worse than a readable measure. `tabIndex={-1}` is what
            makes the skip link able to move focus here. */}
        <main
          id="main-content"
          tabIndex={-1}
          onScroll={(e) => {
            const lifted = e.currentTarget.scrollTop > 4;
            if (lifted !== scrolled) setScrolled(lifted);
          }}
          className="neu-focus flex-1 overflow-y-auto"
        >
          <div
            className={cn(
              "mx-auto px-4 py-6 sm:px-6 lg:px-8",
              sidebarCollapsed ? "max-w-[1600px]" : "max-w-7xl"
            )}
          >
            {children}
          </div>
        </main>
      </div>

      {/* ═══ STORE CURRENCY (formatCurrency defaults) ═══ */}
      <CurrencySync />

      {/* ═══ GLOBAL TOASTS ═══ */}
      <Toaster />
      <PrintPreviewProvider />

      {/* ═══ CROSS-TAB SYNC + CONNECTIVITY ═══ */}
      <SyncIndicator />

      {/* ═══ FIRST-VISIT ONBOARDING ═══ */}
      <WelcomeModal />

      {/* ═══ SEARCH MODAL (⌘K) ═══ */}
      {searchOpen && (
        <div
          ref={searchPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("header.searchModalPlaceholder")}
          className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15dvh]"
          onClick={() => setSearchOpen(false)}
        >
          <div className="fixed inset-0 neu-dialog-overlay" />
          {/* Hard backstop: the palette sits at pt-[15dvh] and stacks an
              input + two lists, so without this its tail could grow past
              the viewport with nothing able to scroll to it. */}
          <div
            className="relative mx-4 w-full max-w-lg max-h-[calc(100dvh-15dvh-1rem)] overflow-y-auto overscroll-contain animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <form
              onSubmit={handleSearch}
              className="flex items-center rounded-xl border border-neu-hairline bg-neu-bg shadow-2xl overflow-hidden"
            >
              <svg
                className="ms-4 h-5 w-5 shrink-0 text-neu-faint"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("header.searchModalPlaceholder")}
                className="flex-1 h-12 px-3 bg-transparent text-neu-primary placeholder:text-neu-faint neu-focus"
              />
              {searching && (
                <span className="me-3 text-xs text-neu-faint">{t("header.searching")}</span>
              )}
              {!searching && searchQuery.length >= 2 && (
                <span className="me-3 text-xs text-neu-faint">
                  {t("header.resultCount", { count: totalResults })}
                </span>
              )}
              <kbd className="me-3 rounded border border-neu-hairline bg-neu-sunken px-2 py-1 text-[10px] font-medium text-neu-faint">
                ESC
              </kbd>
            </form>

            {/* Quick actions — always visible, role-gated */}
            {quickActions.length > 0 && (
              <div className="mt-2 rounded-xl border border-neu-hairline bg-neu-bg shadow-2xl">
                <div className="sticky top-0 border-b border-neu-hairline bg-neu-sunken px-4 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">
                    {t("palette.quickActions")}
                  </p>
                </div>
                <div className="max-h-[24dvh] overflow-y-auto overscroll-contain">
                  {quickActions.map((action) => (
                    <button
                      key={action.href}
                      onClick={() => navigateToResult(action.href)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-neu-accent-wash/60 border-b border-neu-hairline last:border-0"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neu-accent-wash text-neu-accent-ink-strong">
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={1.75}
                          aria-hidden
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d={action.icon} />
                        </svg>
                      </div>
                      <span className="flex-1 truncate text-sm font-medium text-neu-primary">
                        {action.label}
                      </span>
                      <kbd className="rounded border border-neu-hairline bg-neu-sunken px-1.5 py-0.5 text-[10px] font-medium text-neu-faint">
                        ↵
                      </kbd>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Search Results */}
            {searchQuery.length >= 2 && totalResults > 0 && (
              <div className="mt-2 max-h-[40dvh] overflow-y-auto overscroll-contain rounded-xl border border-neu-hairline bg-neu-bg shadow-2xl">
                {Object.entries(searchResults).map(([type, items]) => (
                  <div key={type}>
                    <div className="sticky top-0 border-b border-neu-hairline bg-neu-sunken px-4 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-neu-faint">
                        {type.replace(/_/g, " ")} ({items.length})
                      </p>
                    </div>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => navigateToResult(item.href)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-neu-accent-wash/60 border-b border-neu-hairline last:border-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-neu-primary">
                            {item.title}
                          </p>
                          <p className="truncate text-xs text-neu-faint">{item.subtitle}</p>
                        </div>
                        {item.badge && (
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                              item.badgeVariant === "success"
                                ? "bg-neu-wash-green text-neu-ink-green"
                                : item.badgeVariant === "danger"
                                  ? "bg-neu-wash-red text-neu-ink-red"
                                  : item.badgeVariant === "warning"
                                    ? "bg-neu-wash-amber text-neu-ink-amber"
                                    : "bg-neu-wash-cyan text-neu-ink-cyan"
                            )}
                          >
                            {item.badge}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {searchQuery.length >= 2 && !searching && totalResults === 0 && (
              <div className="mt-2 rounded-xl border border-neu-hairline bg-neu-bg p-8 text-center shadow-2xl">
                <p className="text-sm text-neu-faint">
                  {t("header.noResults")} &quot;{searchQuery}&quot;
                </p>
              </div>
            )}

            <p className="mt-2 text-center text-xs text-neu-faint">{t("header.searchHint")}</p>
          </div>
        </div>
      )}

      {/* ═══ KEYBOARD SHORTCUTS MODAL (⌘/) ═══ */}
      {helpOpen && (
        <div
          ref={helpPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("header.shortcuts")}
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div className="fixed inset-0 neu-dialog-overlay" />
          <div
            className="relative w-full max-w-md rounded-2xl bg-neu-bg shadow-2xl animate-scale-in overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neu-hairline px-6 py-4">
              <h3 className="text-lg font-semibold text-neu-primary">{t("header.shortcuts")}</h3>
              {/* Icon-only, and it had no name at all — neither `aria-label`
                  nor `title`. */}
              <button
                onClick={() => setHelpOpen(false)}
                aria-label={t("common.close")}
                title={t("common.close")}
                className="neu-focus rounded-lg p-1 text-neu-faint hover:bg-neu-sunken hover:text-neu-primary"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-6 py-4 space-y-3 max-h-[60dvh] overflow-y-auto overscroll-contain">
              {[
                { keys: "⌘ K", action: t("common.search") + " (⌘K)" },
                { keys: "⌘ /", action: t("common.close") + " (⌘/)" },
                { keys: "Escape", action: t("common.close") },
                { keys: "F2", action: "POS: " + t("pos.newSale") },
                { keys: "F8", action: "POS: " + t("pos.pay") },
              ].map((shortcut) => (
                <div key={shortcut.action} className="flex items-center justify-between py-1.5">
                  <span className="text-sm text-neu-muted">{shortcut.action}</span>
                  <kbd className="rounded-md border border-neu-hairline bg-neu-sunken px-2 py-1 text-xs font-mono font-medium text-neu-muted">
                    {shortcut.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Nav Icons ─── */
function NavIcon({ name, isActive }: { name: string; isActive: boolean }) {
  // The ink follows the row: the active row is already accent-ink-strong, and
  // a hovered idle row is primary, so the glyph reads at the right weight in
  // every state without a variant of its own.
  const cls = cn("h-5 w-5 shrink-0", isActive ? "text-neu-accent-ink-strong" : "text-neu-faint");
  const icons: Record<string, React.ReactNode> = {
    LayoutDashboard: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
        />
      </svg>
    ),
    Monitor: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25z"
        />
      </svg>
    ),
    Package: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"
        />
      </svg>
    ),
    Warehouse: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z"
        />
      </svg>
    ),
    ShoppingBag: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007zM8.625 10.5a.375.375 0 11-.75 0 .375.375 0 01.75 0zm7.5 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
        />
      </svg>
    ),
    RotateCcw: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"
        />
      </svg>
    ),
    Users: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
        />
      </svg>
    ),
    BarChart3: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />
      </svg>
    ),
    ClipboardList: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
        />
      </svg>
    ),
    TrendingUp: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"
        />
      </svg>
    ),
    Settings: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    Shield: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />
      </svg>
    ),
    Receipt: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
        />
      </svg>
    ),
    Truck: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H18m-2.25-6.75h.008v.008h-.008V9.75zm-1.5 0h.008v.008h-.008V9.75zm-3 0h.008v.008h-.008V9.75zm-3 0h.008v.008h-.008V9.75zM14.25 9.75h.008v.008h-.008V9.75zm-3 0h.008v.008h-.008V9.75zm-6-3.75h12A2.25 2.25 0 0120.25 8.25v7.5A2.25 2.25 0 0118 18H6a2.25 2.25 0 01-2.25-2.25v-7.5A2.25 2.25 0 016 6z"
        />
      </svg>
    ),
    ClipboardDocumentList: (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
        />
      </svg>
    ),
  };
  return <>{icons[name as keyof typeof icons] ?? icons["Package"]}</>;
}
