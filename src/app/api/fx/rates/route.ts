import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
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

export async function GET(_request: NextRequest) {
  try {
    const { response } = await requirePermission(); // session only — all staff render amounts
    if (response) return response;

    const fx = await ensureRates();
    return NextResponse.json({ ...fx, base: "USD" });
  } catch (error) {
    console.error("[FX_RATES_GET]", error);
    return apiError("Internal server error", 500);
  }
}

/**
 * Force refresh: bypass the TTL caches and pull live rates now, then
 * return the fresh snapshot (falls back to the last-known table when
 * both sources are down — never garbage).
 */
export async function POST(request: NextRequest) {
  try {
    const { response } = await requirePermission("settings:edit");
    if (response) return response;

    const fx = await refreshRates();
    return NextResponse.json({ ...fx, base: "USD" });
  } catch (error) {
    console.error("[FX_RATES_POST]", error);
    return apiError("Internal server error", 500);
  }
}
