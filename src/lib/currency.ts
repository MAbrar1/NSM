/* ═══════════════════════════════════════════════════════════════
   CURRENCY FX ENGINE — live, invertible conversion across the system

   Design (why it is exact rather than approximate):
     • Primary source:  open.er-api.com  (165 currencies, no key)
     • Fallback source: api.frankfurter.dev (ECB reference set, no key)
     • Rates are fetched USD-based, then ANY pair is computed via the
       identity rate(A→B) = usd(B) / usd(A) — exact cross-rate math,
       no hardcoded pairs, works for every ISO code both sources list.
     • Server: TTL cache (1h; FX feeds update daily) + a last-known
       snapshot persisted in the DB (StoreSettings.fxRates). If both
       live sources fail, the snapshot keeps conversions correct to
       the last successful sync instead of failing or zeroing out.
     • Client: one cached fetch of /api/fx/rates per window (not per
       format call), registered into lib/currency-core so every
       formatCurrency() call site converts transparently.
     • Conversion is presentation-only: orders and receipts stay in
       the store's base currency; the display layer converts.

   Importing this module (server or client) registers the rate table
   into currency-core — that is the wiring that makes the whole app
   conversion-aware.
   ═══════════════════════════════════════════════════════════════ */

import { registerRateLookup } from "@/lib/currency-core";

export interface FxRates {
  /** USD-based rates: rates[code] = 1 USD buys N of code. */
  rates: Record<string, number>;
  /** When the feed says the rates were computed (ms epoch, 0 if unknown). */
  fetchedAt: number;
  /** Which source produced this snapshot. */
  source: "live" | "db-snapshot" | "static-fallback";
}

const FX_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — feeds refresh daily
const FETCH_TIMEOUT_MS = 8_000;

/* ─── Last-resort static table (never used while any source is alive) ─── */
const STATIC_FALLBACK: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, PKR: 278, INR: 83.3, AED: 3.67, SAR: 3.75,
  CAD: 1.36, AUD: 1.52, CNY: 7.24, JPY: 149.5, TRY: 32.3,
};

/* ─── Server-side cache (module scope) ─── */
let serverCache: FxRates | null = null;
let serverCacheAt = 0;
let inflight: Promise<FxRates> | null = null;

/* ─── Client-side cache (per window) ─── */
interface FxWindow {
  __fxRates?: FxRates;
  __fxRatesAt?: number;
  __fxInflight?: Promise<FxRates> | null;
}
const fxw = (): FxWindow => (typeof window !== "undefined" ? (window as unknown as FxWindow) : ({} as FxWindow));

/* ─── Source adapters ─────────────────────────────────────────── */

async function fetchFromErApi(): Promise<FxRates> {
  const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`er-api HTTP ${r.status}`);
  const d = (await r.json()) as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number };
  if (d.result !== "success" || !d.rates?.["USD"]) throw new Error("er-api payload invalid");
  return { rates: d.rates, fetchedAt: (d.time_last_update_unix ?? 0) * 1000, source: "live" };
}

async function fetchFromFrankfurter(): Promise<FxRates> {
  const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`frankfurter HTTP ${r.status}`);
  const d = (await r.json()) as { rates?: Record<string, number> };
  if (!d.rates) throw new Error("frankfurter payload invalid");
  return { rates: { USD: 1, ...d.rates }, fetchedAt: Date.now(), source: "live" };
}

/* ─── DB snapshot persistence (server only, best-effort) ──────── */

async function loadDbSnapshot(): Promise<Record<string, number> | null> {
  try {
    const { db } = await import("@/lib/db");
    const s = await db.storeSettings.findUnique({ where: { id: "singleton" }, select: { fxRates: true } });
    if (!s?.fxRates) return null;
    const parsed = JSON.parse(s.fxRates) as { rates?: Record<string, number> };
    return parsed.rates ?? null;
  } catch {
    return null; // DB unavailable — fall through to static
  }
}

async function saveDbSnapshot(rates: Record<string, number>): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    const payload = JSON.stringify({ rates, savedAt: new Date().toISOString() });
    await db.storeSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", fxRates: payload },
      update: { fxRates: payload },
    });
  } catch {
    /* snapshot persistence is best-effort by design */
  }
}

/* ─── Public API ──────────────────────────────────────────────── */

/** Current in-memory rates (possibly stale). Null if never loaded. */
export function peekRates(): FxRates | null {
  if (typeof window === "undefined") return serverCache;
  return fxw().__fxRates ?? null;
}

/**
 * Ensure fresh rates are loaded (server cache → client window cache →
 * /api/fx/rates → live sources → DB snapshot → static fallback).
 * Never throws: worst case it resolves with the static fallback table.
 */
export async function ensureRates(): Promise<FxRates> {
  // Client path: one shared request per window, cached 1h.
  if (typeof window !== "undefined") {
    const w = fxw();
    const cached = w.__fxRates;
    if (cached && w.__fxRatesAt && Date.now() - w.__fxRatesAt < FX_CACHE_TTL_MS) return cached;
    if (w.__fxInflight) return w.__fxInflight;
    w.__fxInflight = (async () => {
      try {
        const r = await fetch("/api/fx/rates", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const d = (await r.json()) as FxRates;
        if (!d?.rates?.["USD"]) throw new Error("bad payload");
        w.__fxRates = d;
        w.__fxRatesAt = Date.now();
        return d;
      } catch {
        const fb: FxRates = { rates: STATIC_FALLBACK, fetchedAt: 0, source: "static-fallback" };
        w.__fxRates = w.__fxRates ?? fb; // keep any previous snapshot
        return w.__fxRates;
      } finally {
        w.__fxInflight = null;
      }
    })();
    return w.__fxInflight;
  }

  // Server path.
  if (serverCache && Date.now() - serverCacheAt < FX_CACHE_TTL_MS) return serverCache;
  if (inflight) return inflight;
  inflight = (async (): Promise<FxRates> => {
    try {
      const live = await fetchFromErApi().catch(() => fetchFromFrankfurter());
      serverCache = live;
      serverCacheAt = Date.now();
      void saveDbSnapshot(live.rates); // persist for outage resilience
      return live;
    } catch {
      // Both live sources failed — try the persisted snapshot.
      const snap = await loadDbSnapshot();
      if (snap?.["USD"]) {
        const out: FxRates = { rates: snap, fetchedAt: 0, source: "db-snapshot" };
        serverCache = out;
        serverCacheAt = Date.now();
        return out;
      }
      const out: FxRates = { rates: STATIC_FALLBACK, fetchedAt: 0, source: "static-fallback" };
      serverCache = out;
      serverCacheAt = Date.now();
      return out;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Force a live refresh — bypasses both TTL caches, pulls fresh rates,
 * and persists the snapshot. Used by POST /api/fx/rates so admins can
 * re-sync immediately instead of waiting out the 1-hour cache.
 */
export async function refreshRates(): Promise<FxRates> {
  if (typeof window !== "undefined") {
    // Client: drop the window cache and re-fetch (the endpoint refreshes
    // server-side; the client just needs a payload newer than its cache).
    const w = fxw();
    w.__fxRatesAt = 0;
    return ensureRates();
  }
  try {
    const live = await fetchFromErApi().catch(() => fetchFromFrankfurter());
    serverCache = live;
    serverCacheAt = Date.now();
    void saveDbSnapshot(live.rates);
    return live;
  } catch {
    // Both sources down — keep serving the last-known table.
    return ensureRates();
  }
}

/* ─── The wiring that upgrades every formatCurrency call site ───
   currency-core consults this supplier synchronously each time it
   formats. Registering at module import means any page that imports
   lib/currency (directly or via the provider) gets conversion. */

registerRateLookup(() => {
  if (typeof window === "undefined") return serverCache?.rates ?? null;
  return fxw().__fxRates?.rates ?? null;
});
