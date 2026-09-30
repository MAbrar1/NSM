import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission, type AuthUser } from "@/lib/api/api-auth";

/* ═══════════════════════════════════════════════════════════════
   COMMAND-PALETTE RECENTS API
   Server-side home of the ⌘K palette's "Recent" row so it follows
   a user across browsers and devices.

   GET /api/palette-recents
     → { recents: PaletteRecent[] } — the caller's own list,
       newest visit first, capped at 5.

   PUT /api/palette-recents
     Body: { recents: PaletteRecent[] } — the full list, written
     as the new truth (client already applied cap 5 + dedupe by
     href; the route re-enforces both before storing).

   Scope: the session user is the ONLY subject — there is no userId
   parameter, so a user can never read or write another user's row.
   Any signed-in dashboard user qualifies (the palette itself is
   available to every role), so no extra permission gate.
   ═══════════════════════════════════════════════════════════════ */

const recentSchema = z.object({
  href: z.string().min(1).max(512),
  label: z.string().min(1).max(256),
  icon: z.string().max(2048),
});

const putSchema = z.object({
  recents: z.array(recentSchema).max(5),
});

/** requirePermission, but fail closed with 401 when auth() cannot be
 *  evaluated (outside a request scope) instead of leaking a 500 —
 *  same contract as the seed route. */
async function requireSessionUser(): Promise<
  { user: AuthUser; response: null } | { user: null; response: NextResponse }
> {
  try {
    return await requirePermission();
  } catch {
    return { user: null, response: apiError("Authentication required", 401) };
  }
}

export async function GET() {
  try {
    const { user, response } = await requireSessionUser();
    if (response) return response;

    const rows = await db.paletteRecent.findMany({
      where: { userId: user.id },
      orderBy: { visitedAt: "desc" },
      take: 5,
    });

    return NextResponse.json({
      recents: rows.map((r) => ({ href: r.href, label: r.label, icon: r.icon })),
    });
  } catch (error) {
    console.error("[PALETTE_RECENTS_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { user, response } = await requireSessionUser();
    if (response) return response;

    const body = await request.json().catch(() => null);
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);

    const recents = parsed.data.recents;

    // Defense-in-depth: dedupe by href (first occurrence wins, since
    // the client sends newest-first) and re-cap, in case a client
    // bypasses the store's own invariants.
    const byHref = new Map<string, { href: string; label: string; icon: string }>();
    for (const r of recents) {
      if (!byHref.has(r.href)) byHref.set(r.href, r);
    }
    const capped = [...byHref.values()].slice(0, 5);

    await db.$transaction(async (tx) => {
      await tx.paletteRecent.deleteMany({ where: { userId: user.id } });
      // Bump visitedAt in insertion order so the newest visit sorts
      // first even if timestamps would otherwise collide at 1s
      // precision on some backends.
      const base = Date.now() - capped.length;
      for (const [i, r] of capped.entries()) {
        await tx.paletteRecent.create({
          data: {
            userId: user.id,
            href: r.href,
            label: r.label,
            icon: r.icon,
            visitedAt: new Date(base + i),
          },
        });
      }
    });

    return NextResponse.json({ recents: capped });
  } catch (error) {
    console.error("[PALETTE_RECENTS_PUT]", error);
    return apiError("Internal server error", 500);
  }
}
