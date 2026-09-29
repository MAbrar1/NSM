import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { runSeed, prisma } from "./seed-runner";
import { requirePermission } from "@/lib/api-auth";

/* ═══════════════════════════════════════════════
   SEED API  (development-only)
   POST /api/seed  — re-runs the database seed.

   This endpoint WIPES and repopulates every table, so it is guarded
   defensively:

   - disabled entirely in production;
   - fails closed when SEED_API_KEY is not configured — previously an
     unset key skipped the check and let any caller (curl, a script on
     the LAN) load /api/seed and erase the database in development;
   - otherwise the caller must present a matching `x-seed-key` header;
   - and the caller must be a signed-in settings-level admin
     (`settings:edit`), so a leaked key can't be used by a non-admin.

   The CLI seeder (`npm run db:seed`) calls runSeed() directly and is
   unaffected by any of this.
   ═══════════════════════════════════════════════ */

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return apiError("Disabled in production", 403);
  }

  const expectedKey = process.env["SEED_API_KEY"];
  // Fail closed: no configured key means the endpoint is disabled, not open.
  if (!expectedKey) {
    return NextResponse.json(
      {
        error:
          "Seed API is disabled. Set SEED_API_KEY in the environment, then send it as the x-seed-key header.",
      },
      { status: 403 }
    );
  }

  if (request.headers.get("x-seed-key") !== expectedKey) {
    return apiError("Forbidden", 403);
  }

  // Defense in depth: the key alone is not enough. Even a caller who holds
  // it must be signed in as a settings-level admin (super_admin/admin hold
  // `settings:edit`; manager, cashier, inventory_clerk and viewer do not),
  // so a leaked key can't let a non-admin wipe the database.
  //
  // `auth()` only resolves inside a request scope; if it cannot be evaluated
  // we fail closed with a 401 rather than let the exception bubble into an
  // unhandled 500 (or, worse, proceed).
  let denied = false;
  try {
    const { response } = await requirePermission("settings:edit");
    if (response) return response;
  } catch {
    denied = true;
  }
  if (denied) {
    return apiError("Authentication required", 401);
  }

  try {
    const result = await runSeed();
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[SEED_POST]", err);
    return apiError("Seed failed", 500);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

export async function GET() {
  const enabled =
    process.env.NODE_ENV !== "production" && Boolean(process.env["SEED_API_KEY"]);
  return NextResponse.json(
    enabled
      ? { hint: "POST /api/seed with the x-seed-key header to run the seed" }
      : {
          hint: "Seed API is disabled. Set SEED_API_KEY (and be non-production) to enable it.",
        },
    { status: 200 }
  );
}
