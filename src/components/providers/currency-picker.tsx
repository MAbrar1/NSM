"use client";

import * as React from "react";
import { useI18n } from "@/components/providers/i18n-provider";
import { usePopoverMenu } from "@/hooks/use-popover-menu";
import { useStoreCurrency, useDisplayCurrency, useSetDisplayCurrency } from "@/components/providers/currency-provider";
import { peekRates } from "@/lib/currency";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   CURRENCY PICKER (topbar)
   Per-browser display currency. Conversions are presentation-only:
   every amount in the app re-renders converted at live rates, while
   the store's base currency keeps powering storage, orders, and
   receipts. The choice persists in localStorage per browser.
   ═══════════════════════════════════════════════════════════════ */

/** Curated popular currencies (ISO 4217) shown at the top of the list. */
const POPULAR = [
  "USD", "EUR", "GBP", "PKR", "INR", "AED", "SAR", "CAD",
  "AUD", "CNY", "JPY", "TRY", "CHF", "MYR", "IDR", "BDT",
];

/** A few well-known codes → native names (fallback: the code itself). */
const CURRENCY_NAMES: Record<string, string> = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", PKR: "Pakistani Rupee",
  INR: "Indian Rupee", AED: "UAE Dirham", SAR: "Saudi Riyal", CAD: "Canadian Dollar",
  AUD: "Australian Dollar", CNY: "Chinese Yuan", JPY: "Japanese Yen", TRY: "Turkish Lira",
  CHF: "Swiss Franc", MYR: "Malaysian Ringgit", IDR: "Indonesian Rupiah", BDT: "Bangladeshi Taka",
  ZAR: "South African Rand", NGN: "Nigerian Naira", EGP: "Egyptian Pound", KES: "Kenyan Shilling",
  BRL: "Brazilian Real", MXN: "Mexican Peso", RUB: "Russian Ruble", KRW: "South Korean Won",
  SGD: "Singapore Dollar", NZD: "New Zealand Dollar", QAR: "Qatari Riyal", KWD: "Kuwaiti Dinar",
  OMR: "Omani Rial", BHD: "Bahraini Dinar", LKR: "Sri Lankan Rupee", NPR: "Nepalese Rupee",
  AFN: "Afghan Afghani", IRR: "Iranian Rial", IQD: "Iraqi Dinar", UAH: "Ukrainian Hryvnia",
  PLN: "Polish Zloty", SEK: "Swedish Krona", NOK: "Norwegian Krone", DKK: "Danish Krone",
};

function useOutsideClose(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  React.useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, onClose]);
}

export function CurrencyPicker() {
  const { t } = useI18n();
  const baseCurrency = useStoreCurrency();
  const display = useDisplayCurrency();
  const setDisplay = useSetDisplayCurrency();
  const [open, setOpen] = React.useState(false);
  const [ratesLive, setRatesLive] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  useOutsideClose(rootRef, () => setOpen(false));
  // Arrow keys, Escape, and the focus handoff every other popover in the app
  // already had (this one closed on outside click only, so Escape did nothing
  // and closing it left focus on <body>).
  usePopoverMenu({ open, triggerRef, panelRef, onClose: () => setOpen(false) });

  // Reflect whether live rates are actually loaded (indicator dot).
  React.useEffect(() => {
    const check = () => setRatesLive(!!peekRates());
    check();
    const iv = setInterval(check, 4000);
    return () => clearInterval(iv);
  }, []);

  const effective = display ?? baseCurrency ?? "USD";

  const options: Array<{ code: string | null; label: string }> = [
    { code: null, label: t("currency.storeDefault") },
    ...POPULAR.map((code) => ({ code, label: CURRENCY_NAMES[code] ?? code })),
  ];

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${t("currency.title")} (${effective})`}
        title={t("currency.title")}
        className={cn(
          "neu-btn neu-btn-sm neu-focus gap-1.5 px-2.5 font-medium",
          open ? "bg-neu-sunken text-neu-primary" : "text-neu-muted hover:bg-neu-sunken hover:text-neu-primary"
        )}
      >
        {/* Globe icon */}
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3M3.6 9h16.8M3.6 15h16.8" />
        </svg>
        <span className="tabular-nums">{effective}</span>
        {/* Live-rates indicator */}
        <span
          className={cn("h-1.5 w-1.5 rounded-full", ratesLive ? "bg-neu-solid-green" : "bg-neu-sunken")}
          title={ratesLive ? t("currency.liveRates") : t("currency.offlineRates")}
        />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          aria-label={t("currency.title")}
          /* Under `sm` the list is anchored to the VIEWPORT, not to the
             button: a 240px panel pinned to a header button that sits ~200px
             from the right edge would hang off the left of a 375px screen. */
          className="neu-elevated fixed inset-x-2 top-[4.5rem] z-50 max-h-[min(20rem,calc(100dvh-6rem))] overflow-y-auto overscroll-contain rounded-xl border border-neu-hairline p-1.5 animate-scale-in sm:absolute sm:inset-x-auto sm:end-0 sm:top-full sm:mt-2 sm:w-60"
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-neu-faint">
            {t("currency.title")}
          </p>
          {options.map((opt) => {
            const active = (opt.code ?? null) === (display ?? null);
            return (
              <button
                key={opt.code ?? "base"}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  setDisplay(opt.code);
                  setOpen(false);
                }}
                className={cn(
                  "neu-focus flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  active
                    ? "bg-neu-accent-wash font-semibold text-neu-accent-ink-strong"
                    : "text-neu-primary hover:bg-neu-sunken"
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-9 shrink-0 font-mono text-xs">{opt.code ?? (baseCurrency || "—")}</span>
                  <span className="truncate">{opt.label}</span>
                </span>
                {active && (
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
          <p className="px-2.5 pb-1 pt-2 text-[11px] leading-snug text-neu-faint">
            {t("currency.hint")}
          </p>
        </div>
      )}
    </div>
  );
}
