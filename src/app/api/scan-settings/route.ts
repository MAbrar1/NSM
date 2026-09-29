import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api-errors";
import { requirePermission } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { scanSettingsSchema } from "@/lib/validations/print";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   SCAN SETTINGS API
   GET /api/scan-settings — keyboard-wedge config (any signed-in user;
   the scan hook runs for every operator)
   PUT /api/scan-settings — update (settings:edit)
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    const { response } = await requirePermission();
    if (response) return response;

    let settings = await db.scanSettings.findUnique({ where: { id: "singleton" } });
    if (!settings) {
      settings = await db.scanSettings.create({ data: { id: "singleton" } });
    }
    return NextResponse.json({ settings });
  } catch (error) {
    console.error("[SCAN_SETTINGS_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("settings:edit");
    if (response) return response;

    const body = await request.json();
    const result = scanSettingsSchema.safeParse(body);
    if (!result.success) {
      return validationError(result.error);
    }

    const settings = await db.scanSettings.upsert({
      where: { id: "singleton" },
      update: result.data,
      create: { id: "singleton", ...result.data },
    });

    logAudit({
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: "singleton",
      entityName: "Scan settings",
      newValues: { maxGapMs: settings.maxGapMs, minLength: settings.minLength },
    });

    return NextResponse.json({ settings });
  } catch (error) {
    console.error("[SCAN_SETTINGS_PUT]", error);
    return apiError("Internal server error", 500);
  }
}
