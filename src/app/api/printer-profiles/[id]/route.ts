import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError, validationError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import { db } from "@/lib/db";
import { printerProfileSchema } from "@/lib/validations/print";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   PRINTER PROFILE API
   GET    /api/printer-profiles/[id] — read one
   PUT    /api/printer-profiles/[id] — update (settings:edit)
   DELETE /api/printer-profiles/[id] — soft-disable (settings:edit);
          a profile referenced by print logs is never hard-deleted.
   ═══════════════════════════════════════════════════════════════ */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    const { response } = await requirePermission("settings:view");
    if (response) return response;

    const { id } = await ctx.params;
    const profile = await db.printerProfile.findUnique({ where: { id } });
    if (!profile) return apiError("Printer profile not found", 404);

    return NextResponse.json({ profile });
  } catch (error) {
    console.error("[PRINTER_PROFILE_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { user, response } = await requirePermission("settings:edit");
    if (response) return response;

    const { id } = await ctx.params;
    const existing = await db.printerProfile.findUnique({ where: { id } });
    if (!existing) return apiError("Printer profile not found", 404);

    const body = await request.json();
    const result = printerProfileSchema.safeParse(body);
    if (!result.success) {
      return validationError(result.error);
    }

    const profile = await db.printerProfile.update({
      where: { id },
      data: result.data,
    });

    logAudit({
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: id,
      entityName: `Printer profile: ${profile.name}`,
      oldValues: { name: existing.name, printableDots: existing.printableDots },
      newValues: { name: profile.name, printableDots: profile.printableDots },
    });

    return NextResponse.json({ profile });
  } catch (error) {
    console.error("[PRINTER_PROFILE_PUT]", error);
    return apiError("Internal server error", 500);
  }
}

export async function DELETE(_request: NextRequest, ctx: Ctx) {
  try {
    const { user, response } = await requirePermission("settings:edit");
    if (response) return response;

    const { id } = await ctx.params;
    const existing = await db.printerProfile.findUnique({ where: { id } });
    if (!existing) return apiError("Printer profile not found", 404);

    // Referenced by print logs → soft-disable instead of delete so the
    // audit trail's FK stays intact.
    const logCount = await db.receiptPrintLog.count({ where: { printerProfileId: id } });
    if (logCount > 0) {
      const profile = await db.printerProfile.update({
        where: { id },
        data: { isEnabled: false, defaultFor: null },
      });
      logAudit({
        userId: user.id,
        action: "update",
        entity: "settings",
        entityId: id,
        entityName: `Printer profile: ${profile.name}`,
        newValues: { disabled: true, reason: "referenced by print log" },
      });
      return NextResponse.json({ profile, disabled: true });
    }

    await db.printerProfile.delete({ where: { id } });
    logAudit({
      userId: user.id,
      action: "delete",
      entity: "settings",
      entityId: id,
      entityName: `Printer profile: ${existing.name}`,
      oldValues: { name: existing.name },
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[PRINTER_PROFILE_DELETE]", error);
    return fieldError({ profile: ["Could not delete printer profile"] }, 500);
  }
}
