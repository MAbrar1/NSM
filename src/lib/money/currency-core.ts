/* ═══════════════════════════════════════════════════════════════
   CURRENCY CORE — formatting primitives, app-wide defaults, and
   display-currency conversion.

   Convention across the whole system:
     • Amounts are stored as INTEGER CENTS of the store's BASE
       currency. formatCurrency(500_00) means 500 base units.
     • An optional DISPLAY currency (set per browser by the
       currency picker) converts those base cents for presentation
       only, using live USD-based cross rates supplied by the FX
       engine (lib/currency.ts). Storage, orders, and printed
       receipts always stay in base currency.

   Why conversion lives here: 190+ call sites format client-side
   through formatCurrency/formatAmount with base-currency cents.
   Making the formatter conversion-aware upgrades the entire app
   with zero call-site churn, and callers that pass an explicit
   `currency` (statements, exports) keep their exact semantics.

   lib/currency.ts registers a rate lookup at import time — the
   formatter consults it synchronously; if rates have not loaded
   yet it renders base currency (never a wrong unit), and pages
   re-render once rates arrive (CurrencySync bumps the store).
   ═══════════════════════════════════════════════════════════════ */

const envCurrency = (process.env["NEXT_PUBLIC_DEFAULT_CURRENCY"] ?? "").trim();
let defaultCurrency = /^[A-Za-z]{3}$/.test(envCurrency) ? envCurrency.toUpperCase() : "USD";
let defaultLocale = "en-US";

/* ─── Display-currency state ─── */
let displayCurrency: string | null = null; // null = follow base

/** Synchronous rate-table supplier, registered by lib/currency.ts. */
let rateLookup: () => Record<string, number> | null = () => null;

import { centsToMajorString } from "./money";

export function registerRateLookup(fn: () => Record<string, number> | null): void {
  rateLookup = fn;
}

/** Override the app-wide BASE currency formatting defaults. */
export function setCurrencyDefaults(currency?: string | null, locale?: string | null): void {
  const c = (currency ?? "").trim();
  if (/^[A-Za-z]{3}$/.test(c)) defaultCurrency = c.toUpperCase();
  if (locale && locale.trim()) defaultLocale = locale.trim();
}

/** Current app-wide BASE currency formatting defaults. */
export function getCurrencyDefaults(): { currency: string; locale: string } {
  return { currency: defaultCurrency, locale: defaultLocale };
}

/**
 * Set the per-browser display currency (ISO code), or null to follow
 * the store's base currency. Applied by the currency picker.
 */
export function setDisplayCurrency(code: string | null): void {
  if (code === null) {
    displayCurrency = null;
    return;
  }
  const c = (code ?? "").trim();
  displayCurrency = /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : null;
}

/** Active display currency (null = follow base). */
export function getDisplayCurrency(): string | null {
  return displayCurrency;
}

/* ─── Pure cross-rate math (USD-based table) ───
   rate(A→B) = usd(B) / usd(A) — exact for any pair the table lists. */

/** Exact cross rate for any pair. Unknown codes resolve to 0. */
export function fxRate(from: string, to: string, rates: Record<string, number>): number {
  const f = rates[from?.toUpperCase?.() ?? ""] ?? 0;
  const t = rates[to?.toUpperCase?.() ?? ""] ?? 0;
  if (!f || !t) return 0;
  return t / f;
}

/** Convert integer cents between currencies (result: integer cents). */
export function fxConvertCents(amount: number, from: string, to: string, rates: Record<string, number>): number {
  if (from === to) return amount;
  const r = fxRate(from, to, rates);
  if (!r) return amount;
  return Math.round(amount * r);
}

/* ─── Reverse path: what the cashier TYPED is display currency ────
   Every on-screen money input (tender, settle, discount, per-unit
   amount, chips) is interpreted in the currency the cashier sees.
   While the display currency equals the store base these are exact
   round(×100) identities; when a converted currency is active they
   round-trip what the user typed back into base cents so stored
   amounts stay in the store's base unit. */

/** Display-major value (what the user typed/what a chip shows) → base cents. */
export function displayMajorToBaseCents(major: number, rates: Record<string, number> | null): number {
  if (!Number.isFinite(major) || major <= 0) return 0;
  if (!displayCurrency || !rates || displayCurrency === defaultCurrency) {
    return Math.round(major * 100); // identity: display IS the base
  }
  const cents = fxConvertCents(Math.round(major * 100), displayCurrency, defaultCurrency, rates);
  return cents > 0 ? cents : Math.round(major * 100);
}

/** Base cents → display-major string for prefilling money inputs.
 *  Always 2 decimals — matches formatCurrency's fixed 2-decimal
 *  rendering, so prefills equal exactly what the cashier sees. */
export function baseCentsToDisplayMajorStr(cents: number, rates: Record<string, number> | null): string {
  if (!Number.isFinite(cents) || cents <= 0) return "";
  if (!displayCurrency || !rates || displayCurrency === defaultCurrency) {
    return centsToMajorString(cents); // identity: base major
  }
  const converted = fxConvertCents(cents, defaultCurrency, displayCurrency, rates);
  return centsToMajorString(converted);
}

/** True when the display currency differs from the store base (rates live). */
export function isDisplayConverted(rates: Record<string, number> | null): boolean {
  return Boolean(displayCurrency && rates && displayCurrency !== defaultCurrency);
}

/** Resolve the effective (code, cents) for a base-cents amount. */
function resolveDisplay(
  amount: number,
  currency: string,
  locale: string
): { code: string; cents: number; loc: string } {
  if (
    displayCurrency &&
    displayCurrency !== currency &&
    currency === defaultCurrency
  ) {
    const rates = rateLookup();
    if (rates) {
      const converted = fxConvertCents(amount, currency, displayCurrency, rates);
      return { code: displayCurrency, cents: converted, loc: locale };
    }
    // Rates not loaded yet — render base (never a wrong unit); the
    // CurrencySync bump re-renders pages once rates arrive.
  }
  return { code: currency, cents: amount, loc: locale };
}

/** Format an amount given in smallest units (cents of `currency`). */
export function formatCurrency(
  amount: number,
  currency: string = defaultCurrency,
  locale: string = defaultLocale
): string {
  const d = resolveDisplay(amount, currency, locale);
  return new Intl.NumberFormat(d.loc, {
    style: "currency",
    currency: d.code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(d.cents / 100);
}

/** Format strictly in the store's BASE currency — no display conversion.
 *  For legal/printed artifacts (receipts, invoices, exports) whose amounts
 *  are stored base-cents records: printing them converted would misstate
 *  the actual tendered/owed amounts. The popup window also can't inherit
 *  live rates reliably, so it pins the base code directly. */
export function formatCurrencyBase(
  amount: number,
  currency: string = defaultCurrency,
  locale: string = defaultLocale
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

/** Format a raw decimal amount (not in cents). */
export function formatAmount(
  amount: number,
  currency: string = defaultCurrency,
  locale: string = defaultLocale
): string {
  const d = resolveDisplay(amount * 100, currency, locale);
  return new Intl.NumberFormat(d.loc, {
    style: "currency",
    currency: d.code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(d.cents / 100);
}
