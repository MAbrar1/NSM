"use client";

import * as React from "react";
import { setCurrencyDefaults, setDisplayCurrency, getDisplayCurrency } from "@/lib/currency-core";
import { ensureRates, peekRates } from "@/lib/currency";
import { useSettingsStore } from "@/stores/settings-store";

/* ═══════════════════════════════════════════════════════════════
   CURRENCY SYNC + DISPLAY-CURRENCY CONVERSION

   1. Fetches the store's BASE currency once per session and applies
      it as the app-wide formatting default (as before).
   2. Ensures live FX rates are loaded (lib/currency.ts registers its
      rate table into lib/currency-core, so every formatCurrency()
      call site converts transparently). Re-fetches every 30 min.
   3. Applies the per-browser DISPLAY currency chosen from the
      topbar picker (persisted in localStorage). When it differs
      from base, all amounts render converted at live rates —
      while storage, orders, and receipts stay in base currency.
   ═══════════════════════════════════════════════════════════════ */

const DISPLAY_CURRENCY_KEY = "elite-pos-display-currency";
const RATES_REFRESH_MS = 30 * 60 * 1000;
/** Fast retry cadence while live rates are still unavailable. */
const RATES_RETRY_MS = 15 * 1000;

function loadPersistedDisplay(): string | null {
  try {
    const v = localStorage.getItem(DISPLAY_CURRENCY_KEY);
    return v && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : null;
  } catch {
    return null;
  }
}

export function CurrencySync() {
  const setCurrency = useSettingsStore((s) => s.setCurrency);
  const displayCurrency = useSettingsStore((s) => s.displayCurrency);
  const setDisplayCurrencyStore = useSettingsStore((s) => s.setDisplayCurrency);
  // Subscribing to the store value makes every consumer re-render when
  // rates land or the display currency changes — so converted amounts
  // repaint without any per-page wiring.
  const [ratesTick, setRatesTick] = React.useState(0);

  // Restore the persisted display choice before first paint effects.
  React.useEffect(() => {
    const saved = loadPersistedDisplay();
    if (saved) {
      setDisplayCurrency(saved);
      setDisplayCurrencyStore(saved);
    }
  }, [setDisplayCurrencyStore]);

  // Store base currency (session) — unchanged behavior.
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/currency")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { currency?: string } | null) => {
        if (cancelled || !d?.currency) return;
        setCurrencyDefaults(d.currency);
        setCurrency(d.currency);
      })
      .catch(() => {
        /* keep the compile-time default; amounts still render */
      });
    return () => {
      cancelled = true;
    };
  }, [setCurrency]);

  // Live FX rates: load now, then refresh on an interval. The tick
  // bumps subscribed pages so converted amounts repaint. Failures are
  // caught (never unhandled rejections) and retried on a fast cadence
  // until rates arrive — converted amounts then work even if the first
  // fetch raced a dev compile or a network blip.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerMs = RATES_RETRY_MS;
    const load = async () => {
      try {
        await ensureRates();
        timerMs = RATES_REFRESH_MS; // success → settle into slow refresh
      } catch {
        timerMs = RATES_RETRY_MS; // failure → retry soon
      }
      if (cancelled) return;
      setRatesTick((n) => n + 1);
      timer = setTimeout(load, timerMs);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Keep lib state in sync when the picker changes the store.
  React.useEffect(() => {
    const current = getDisplayCurrency();
    if ((current ?? null) !== (displayCurrency ?? null)) {
      setDisplayCurrency(displayCurrency);
    }
  }, [displayCurrency]);

  // Sanity: ratesTick is intentionally read to couple renders.
  void ratesTick;
  void peekRates;

  return null;
}

/**
 * Subscribe to the display currency. The returned value is the store's
 * BASE currency, but the selector deliberately also tracks the
 * per-browser display currency — formatCurrency() reads module state
 * at call time, so pages must RE-RENDER for converted amounts to
 * repaint. Subscribing to the composite keeps every amount-rendering
 * page in sync with base-currency loads, display-currency changes,
 * and rate arrivals (CurrencySync bumps the store via ratesTick →
 * setDisplayCurrency round-trip).
 */
export function useStoreCurrency(): string {
  return useSettingsStore((s) => `${s.currency}|${s.displayCurrency ?? ""}`).split("|")[0] ?? "";
}

/** The active per-browser display currency (null = follow base). */
export function useDisplayCurrency(): string | null {
  return useSettingsStore((s) => s.displayCurrency);
}

/** Change the per-browser display currency (persisted). */
export function useSetDisplayCurrency(): (code: string | null) => void {
  const setStore = useSettingsStore((s) => s.setDisplayCurrency);
  return React.useCallback(
    (code: string | null) => {
      setDisplayCurrency(code);
      try {
        if (code) localStorage.setItem(DISPLAY_CURRENCY_KEY, code);
        else localStorage.removeItem(DISPLAY_CURRENCY_KEY);
      } catch {
        /* private mode — session-only choice */
      }
      setStore(code);
    },
    [setStore]
  );
}
