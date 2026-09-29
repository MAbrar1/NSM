import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/* ═══════════════════════════════════════════════════════════════
   HEALTH / READINESS PROBE
   GET /api/health — Infrastructure probe for uptime monitors,
   container orchestrators and load balancers.

   - liveness  (`?probe=live`): process is up — never touches the DB.
   - readiness (default):      verifies the database answers a trivial
     query within the timeout, so a stalled DB takes the instance out
     of rotation instead of serving 500s.

   Deliberately UNAUTHENTICATED (middleware's publicRoutes must stay
   untouched): probes carry no session. It exposes zero business data —
   only { status, db, latencyMs, uptimeSeconds, timestamp }.
   ═══════════════════════════════════════════════════════════════ */

const DB_CHECK_TIMEOUT_MS = 2_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const started = Date.now();
  const payload: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  };

  // Liveness: process-level only.
  if (searchParams.get("probe") === "live") {
    return NextResponse.json(payload, { status: 200 });
  }

  // Readiness: confirm the database answers. SELECT 1 is the cheapest
  // possible round-trip; a stalled/locked DB fails the timeout and the
  // probe returns 503 so traffic can be drained.
  let dbOk = false;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db timeout")), DB_CHECK_TIMEOUT_MS)
      ),
    ]);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  payload["db"] = dbOk ? "up" : "down";
  payload["latencyMs"] = Date.now() - started;

  return NextResponse.json(payload, {
    status: dbOk ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
