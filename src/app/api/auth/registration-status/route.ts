import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/* ═══════════════════════════════════════════════════════════════
   REGISTRATION STATUS API (public)
   GET /api/auth/registration-status
   Tells the register page whether public signup is currently open.
   Registration is open when the admin toggle is enabled, OR when
   the system has no users yet (bootstrap first-run).
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    let open = false;

    // Bootstrap: allow the very first account when no users exist
    const userCount = await db.user.count({ where: { deletedAt: null } });
    if (userCount === 0) {
      open = true;
    } else {
      const settings = await db.storeSettings.findUnique({
        where: { id: "singleton" },
      });
      open = settings?.allowPublicRegistration ?? false;
    }

    return NextResponse.json({ open });
  } catch (error) {
    console.error("[REGISTRATION_STATUS]", error);
    return NextResponse.json({ open: false }, { status: 500 });
  }
}