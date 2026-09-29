"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useStockSync, type StockChangeEvent, type RefreshRequest } from "@/hooks/use-stock-sync";
import { useI18n } from "@/components/providers/i18n-provider";

/* ═══════════════════════════════════════════════════════════════
   CROSS-TAB SYNC INDICATOR
   A quiet, professional status pill docked bottom-right on every
   dashboard page. It answers two questions a cashier actually has:

   1. Am I online?        → green "Live" / amber "Offline" (navigator)
   2. Did another terminal just change stock?
                          → a 4-second "Synced" pulse so staff trust
                            that prices/stock across tabs agree.

   It listens on the same BroadcastChannel the POS uses; events from
   the tab itself never arrive (BroadcastChannel skips the sender),
   so a pulse always means a genuinely remote change. Purely visual —
   data refresh is each page's own job.
   ═══════════════════════════════════════════════════════════════ */

type Pulse = { id: number; label: string } | null;

export function SyncIndicator() {
  const { t } = useI18n();
  const [online, setOnline] = React.useState(true);
  const [pulse, setPulse] = React.useState<Pulse>(null);
  const pulseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseId = React.useRef(0);

  // Connectivity (offline-capable registers still need the truth)
  React.useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const showPulse = React.useCallback((label: string) => {
    pulseId.current += 1;
    setPulse({ id: pulseId.current, label });
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulse(null), 4000);
  }, []);

  React.useEffect(() => {
    return () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    };
  }, []);

  useStockSync(
    React.useCallback(
      (_event: StockChangeEvent) => {
        showPulse(t("sync.stockUpdated"));
      },
      [showPulse, t]
    ),
    React.useCallback(
      (_event: RefreshRequest) => {
        showPulse(t("sync.refreshed"));
      },
      [showPulse, t]
    )
  );

  return (
    <div
      className={cn(
        // Docked above any page chrome; never intercepts clicks except on itself
        // `end-4` (not `right-4`): the pill is anchored to the shell's
        // trailing edge, which is the LEFT one in Urdu.
        "fixed bottom-4 end-4 z-[var(--z-overlay,40)] flex items-center gap-2 select-none",
        "pointer-events-none transition-all duration-300"
      )}
      role="status"
      aria-live="polite"
    >
      {/* Transient cross-tab pulse */}
      {pulse && (
        <span
          key={pulse.id}
          className={cn(
            "pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-1.5",
            "bg-neu-scrim/90 text-white text-xs font-medium shadow-lg backdrop-blur-sm",
            "animate-scale-in"
          )}
        >
          <svg className="h-3.5 w-3.5 text-neu-ink-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          {pulse.label}
        </span>
      )}

      {/* Persistent connection state */}
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2.5 py-1",
          "text-[11px] font-medium shadow-sm backdrop-blur-sm",
          online
            ? "border-neu-ink-green/20 bg-neu-wash-green text-neu-ink-green"
            : "border-neu-ink-amber/30 bg-neu-wash-amber text-neu-ink-amber"
        )}
        title={online ? t("sync.liveTitle") : t("sync.offlineTitle")}
      >
        <span className="relative flex h-2 w-2">
          {online && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-neu-solid-green opacity-60" />
          )}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              online ? "bg-neu-solid-green" : "bg-neu-solid-amber"
            )}
          />
        </span>
        {online ? t("sync.live") : t("sync.offline")}
      </span>
    </div>
  );
}
