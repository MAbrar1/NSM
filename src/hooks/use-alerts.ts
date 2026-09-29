"use client";

import * as React from "react";
import { parseAlertFeed, type AlertFeed } from "@/lib/alert-utils";

/* ═══════════════════════════════════════════════════════════════
   USE ALERTS — one owner for the stock-alert feed
   Fetching, warehouse scoping, freshness and refresh state used to be
   inlined in the dashboard shell, and duplicated (badly) in the bell.
   They both read the SAME /api/alerts feed through this hook now, so
   the two surfaces can never disagree about loading or failure.

   The hook is deliberately TRANSPORT-only: `status` describes the
   request (`loading` → `ready` → `error`), never the app's policy.
   The "in-app channel is switched off" state is a property of the
   feed (`feed.inAppEnabled`), which each surface interprets for
   itself — the bell goes quiet, the dashboard widget (a data panel)
   keeps rendering. Baking that policy into `status` is what would
   have forced the dashboard to special-case it.

   Guarantees:
   • loading/ready/error is a real state machine — a failure with no
     prior data is `error`, so a failed scan can never render as an
     empty (all-good) feed;
   • polling skips hidden tabs and refetches on return;
   • scope changes / unmount abort the in-flight request;
   • responses are parsed defensively (parseAlertFeed).
   ═══════════════════════════════════════════════════════════════ */

/** 60s matches the dashboard's refresh cadence. */
export const ALERTS_POLL_MS = 60_000;

/** Transport state only. See the note above. */
export type AlertsStatus = "loading" | "ready" | "error";

export interface UseAlertsResult {
  feed: AlertFeed | null;
  status: AlertsStatus;
  /** Latest failure, even when stale data is still on screen. */
  error: string | null;
  /** A background refresh is in flight (data already on screen). */
  refreshing: boolean;
  /** When the currently rendered feed was last applied. */
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}

export interface UseAlertsOptions {
  /** null/undefined = all warehouses. */
  warehouseId?: string | null;
  /** Set false to suspend polling (e.g. a surface that fetches on demand). */
  poll?: boolean;
}

export function useAlerts({
  warehouseId,
  poll = true,
}: UseAlertsOptions = {}): UseAlertsResult {
  const [feed, setFeed] = React.useState<AlertFeed | null>(null);
  const [status, setStatus] = React.useState<AlertsStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);
  const inflight = React.useRef<AbortController | null>(null);
  // Have we ever rendered real data? Decides whether a failure blanks the
  // surface (cold error) or just flags the stale feed (warm error).
  const hasData = React.useRef(false);

  const scope = warehouseId ?? "";
  // Keep a stable reference for the poll effect without re-subscribing it
  // every time a caller re-renders (the ref only changes when scope does).
  const scopeRef = React.useRef(scope);
  scopeRef.current = scope;

  const refresh = React.useCallback(async () => {
    // A newer request supersedes the old one (scope changed mid-flight).
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;

    const currentScope = scopeRef.current;
    setRefreshing(true);
    try {
      const url = currentScope
        ? `/api/alerts?warehouseId=${encodeURIComponent(currentScope)}`
        : "/api/alerts";
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Alerts request failed (${res.status})`);
      const parsed = parseAlertFeed(await res.json());
      if (controller.signal.aborted) return;

      hasData.current = true;
      setFeed(parsed);
      setLastUpdated(new Date());
      setError(null);
      setStatus("ready");
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError"))
        return;
      setError(err instanceof Error ? err.message : "Unknown error");
      // A transient failure must not blank the surface and it must not lie and
      // say "all stocked". If we already had a feed on screen, keep it and just
      // flag the stale-timestamp area in the footer. Only a cold failure
      // (no prior data) becomes the error state.
      if (!hasData.current) {
        setStatus("error");
        setFeed(null);
      }
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }, []);

  // Fetch once on mount and whenever the scope changes.
  React.useEffect(() => {
    void refresh();
  }, [scope, refresh]);

  // Polling runs for the lifetime of the hook (not re-created per scope).
  React.useEffect(() => {
    if (!poll) return;
    const interval = setInterval(() => {
      // A hidden tab does not need to poll; the visibility listener below
      // refreshes immediately when the user comes back.
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    }, ALERTS_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      inflight.current?.abort();
    };
  }, [poll, refresh]);

  return { feed, status, error, refreshing, lastUpdated, refresh };
}
