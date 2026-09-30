"use client";

import * as React from "react";
import { useI18n } from "@/components/providers/i18n-provider";
import { toast } from "@/stores/toast-store";
import { cn, formatCurrency } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER PICKER (POS)
   Searchable customer combobox for the register:
   - Focus → shows recent customers (server-ordered)
   - Type ≥ 2 chars → debounced search by name/email/phone
   - Keyboard navigation (↑↓↵ Esc)
   - Inline quick-create: \"Create new customer '…'\" (uses the same
     customers:create permission as the Customers screen)
   - Selected state shows name + phone/email + loyalty points
   ═══════════════════════════════════════════════════════════════ */

export interface PickedCustomer {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  loyaltyPoints?: number;
  /** Cents this customer still owes the store (khata balance). */
  outstandingBalance?: number;
}

interface CustomerPickerProps {
  value: PickedCustomer | null;
  onSelect: (customer: PickedCustomer | null) => void;
  compact?: boolean;
}

/* SVG star — crisp at small sizes and theme-aware, unlike an emoji glyph */
function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.958a1 1 0 00.95.69h4.162c.969 0 1.371 1.24.588 1.81l-3.367 2.446a1 1 0 00-.363 1.118l1.286 3.958c.3.922-.755 1.688-1.539 1.118l-3.367-2.446a1 1 0 00-1.175 0l-3.367 2.446c-.783.57-1.838-.196-1.538-1.118l1.285-3.958a1 1 0 00-.363-1.118L2.98 9.385c-.783-.57-.38-1.81.588-1.81h4.163a1 1 0 00.95-.69l1.286-3.958z" />
    </svg>
  );
}

export function CustomerPicker({ value, onSelect, compact }: CustomerPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PickedCustomer[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Debounced search. Opening the picker with an empty query shows the most
  // recent customers (handy for repeat walk-ins).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const q = query.trim();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/customers?search=${encodeURIComponent(q)}&pageSize=8`
        );
        const data = await res.json();
        if (!cancelled) {
          setResults((data.items ?? []) as PickedCustomer[]);
          setActiveIndex(0);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, q.length >= 2 ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  // Close on outside click
  React.useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  // Focus the input when the picker opens
  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function pick(customer: PickedCustomer) {
    onSelect(customer);
    setOpen(false);
    setQuery("");
    setResults([]);
  }

  function remove() {
    onSelect(null);
    setQuery("");
    setResults([]);
  }

  async function createCustomer(name: string) {
    const clean = name.trim();
    if (!clean || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t("common.error"), typeof data.error === "string" ? data.error : "Could not create customer");
        return;
      }
      const created = data.customer as PickedCustomer;
      pick(created);
      toast.success(t("common.success"), `${clean} ${t("customers.added")}`);
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
    } finally {
      setCreating(false);
    }
  }

  // Keyboard navigation
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const count = results.length + (canCreate ? 1 : 0);
      setActiveIndex((i) => (i + 1) % Math.max(1, count));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const count = results.length + (canCreate ? 1 : 0);
      setActiveIndex((i) => (i <= 0 ? count - 1 : i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Create row is the last entry when shown
      if (canCreate && activeIndex === results.length) {
        void createCustomer(query);
        return;
      }
      const target = results[activeIndex];
      if (target) pick(target);
    }
  }

  const trimmed = query.trim();
  const canCreate =
    trimmed.length >= 2 && !results.some((c) => c.name.toLowerCase() === trimmed.toLowerCase());

  // ── Selected state ────────────────────────────────────────────
  if (value) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-neu-accent-line bg-neu-accent-wash px-2.5 py-1.5 animate-fade-in",
          compact ? "w-full" : ""
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neu-accent-solid text-[10px] font-bold text-white">
          {value.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-neu-primary">
            {value.name}
          </span>
          {(value.phone || value.email) && (
            <span className="block truncate text-[10px] text-neu-faint">
              {value.phone || value.email}
            </span>
          )}
        </span>
        {typeof value.loyaltyPoints === "number" && value.loyaltyPoints > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-neu-bg px-2 py-0.5 text-[10px] font-bold tabular-nums text-neu-accent-ink-strong shadow-sm"
            title={t("pos.customerLoyaltyPoints")}
          >
            <StarIcon className="h-2.5 w-2.5" /> {value.loyaltyPoints}
          </span>
        )}
        {typeof value.outstandingBalance === "number" && value.outstandingBalance > 0 && (
          <span
            className="shrink-0 rounded-full bg-neu-wash-red px-2 py-0.5 text-[10px] font-bold tabular-nums text-neu-ink-red shadow-sm"
            title={t("pos.customerDueTitle")}
          >
            {t("pos.customerDue")}: {formatCurrency(value.outstandingBalance)}
          </span>
        )}
        <button
          type="button"
          onClick={remove}
          className="shrink-0 rounded-md p-1 text-neu-faint transition-colors hover:bg-neu-bg hover:text-neu-ink-red"
          aria-label={t("pos.removeCustomer")}
          title={t("pos.removeCustomer")}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  // ── Search state ──────────────────────────────────────────────
  return (
    <div ref={rootRef} className={cn("relative", compact ? "w-full" : "")}>
      <div className="relative">
        <svg
          className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neu-faint"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={t("pos.customerSearchPlaceholder")}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full rounded-lg border border-neu-hairline bg-neu-bg text-xs text-neu-primary placeholder:text-neu-faint neu-focus",
            compact ? "h-9 px-8" : "h-8 px-8"
          )}
        />
        {loading && (
          <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-[10px] text-neu-faint">
            {t("common.loading")}…
          </span>
        )}
      </div>

      {open && (
        <div className="neu-popover absolute start-0 end-0 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-xl border border-neu-hairline bg-neu-bg animate-scale-in pos-scroll">
          {results.length === 0 && !loading && (
            <p className="px-3 py-2.5 text-xs text-neu-faint">
              {trimmed.length >= 2 ? t("pos.customerNoResults") : t("pos.customerSearchPlaceholder")}
            </p>
          )}
          {results.map((customer, index) => (
            <button
              key={customer.id}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => pick(customer)}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-start transition-colors",
                index === activeIndex ? "bg-neu-accent-wash" : "hover:bg-neu-sunken"
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neu-sunken text-[10px] font-bold text-neu-faint">
                {customer.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-neu-primary">
                  {customer.name}
                </span>
                {(customer.phone || customer.email) && (
                  <span className="block truncate text-[10px] text-neu-faint">
                    {customer.phone || customer.email}
                  </span>
                )}
              </span>
              {typeof customer.loyaltyPoints === "number" && customer.loyaltyPoints > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold tabular-nums text-neu-accent-ink">
                  <StarIcon className="h-2.5 w-2.5" /> {customer.loyaltyPoints}
                </span>
              )}
              {typeof customer.outstandingBalance === "number" && customer.outstandingBalance > 0 && (
                <span className="shrink-0 text-[10px] font-bold tabular-nums text-neu-ink-red">
                  {formatCurrency(customer.outstandingBalance)}
                </span>
              )}
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              onMouseEnter={() => setActiveIndex(results.length)}
              onClick={() => void createCustomer(query)}
              disabled={creating}
              className={cn(
                "flex w-full items-center gap-2 border-t border-neu-hairline px-3 py-2 text-start transition-colors disabled:opacity-60",
                activeIndex === results.length ? "bg-neu-accent-wash" : "hover:bg-neu-sunken"
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neu-accent-solid text-white">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-neu-accent-ink-strong">
                {creating ? `${t("common.loading")}…` : `${t("pos.customerCreate")} "${trimmed}"`}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}