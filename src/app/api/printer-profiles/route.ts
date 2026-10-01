import { NextResponse } from "next/server";
import { validationError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { db } from "@/lib/db";
import { printerProfileSchema } from "@/lib/validations/print";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   PRINTER PROFILES API
   GET  /api/printer-profiles — list (any settings viewer / POS user)
   POST /api/printer-profiles — create (settings:edit)
   Profiles hold every thermal number (width, dots, band, feed) as
   data — custom widths like 88 mm are a new row, never code.
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler("PRINTER_PROFILES_GET", async () => {
    const { response } = await requirePermission("settings:view");
    if (response) return response;

    const profiles = await db.printerProfile.findMany({
      orderBy: [{ isEnabled: "desc" }, { name: "asc" }],
    });
    return NextResponse.json({ profiles });
  });

export const POST = withApiHandler("PRINTER_PROFILES_POST", async (request) => {
    const { user, response } = await requirePermission("settings:edit");
    if (response) return response;

    const body = await request.json();
    const result = printerProfileSchema.safeParse(body);
    if (!result.success) {
      return validationError(result.error);
    }

    const profile = await db.printerProfile.create({ data: result.data });

    logAudit({
      userId: user.id,
      action: "create",
      entity: "settings",
      entityId: profile.id,
      entityName: `Printer profile: ${profile.name}`,
      newValues: { name: profile.name, paperWidthMm: profile.paperWidthMm, printableDots: profile.printableDots },
    });

    return NextResponse.json({ profile }, { status: 201 });
  });
