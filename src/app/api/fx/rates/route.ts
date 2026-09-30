import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { ensureRates } from "@/lib/money/currency";
import { refreshRates } from "@/lib/money/currency";

/* ═══════════════════════════════════════════════════════════════
   FX RATES API
   GET /api/fx/rates          — USD-based rates (1h server cache;
                                falls back to the DB snapshot, then
                                a static table; never fails open
                                with garbage)
   POST /api/fx/rates         — force refresh (settings:edit)
   Response: { rates: Record<code, number>, fetchedAt, source,
               base: "USD" }
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler("FX_RATES_GET", async (_request) => {
    const { response } = await requirePermission(); // session only — all staff render amounts
    if (response) return response;

    const fx = await ensureRates();
    return NextResponse.json({ ...fx, base: "USD" });
  });

/**
 * Force refresh: bypass the TTL caches and pull live rates now, then
 * return the fresh snapshot (falls back to the last-known table when
 * both sources are down — never garbage).
 */
export const POST = withApiHandler("FX_RATES_POST", async (_request) => {
    const { response } = await requirePermission("settings:edit");
    if (response) return response;

    const fx = await refreshRates();
    return NextResponse.json({ ...fx, base: "USD" });
  });
