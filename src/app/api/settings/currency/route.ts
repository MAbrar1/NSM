import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";

/* ═══════════════════════════════════════════════════════════════
   SETTINGS — DISPLAY CURRENCY (lightweight)
   GET /api/settings/currency — returns only the store's currency.

   Session-authenticated but NOT gated behind settings:view: every
   signed-in user needs the currency to render amounts, while the
   full settings document (SMTP/webhook secrets) stays restricted.
   Fails open with USD so amounts always render.
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    const { response } = await requirePermission(); // session only, no permission check
    if (response) return response;

    const settings = await db.storeSettings.findUnique({
      where: { id: "singleton" },
      select: { currency: true },
    });

    return NextResponse.json({ currency: settings?.currency ?? "USD" });
  } catch (error) {
    console.error("[SETTINGS_CURRENCY_GET]", error);
    return NextResponse.json({ currency: "USD" });
  }
}
