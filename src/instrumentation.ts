/* ═══════════════════════════════════════════════════════════════
   INSTRUMENTATION — server lifecycle hook
   Registers the periodic server-side jobs when the app runs for
   real (`next start`):
   - low-stock scan + notifications  (lib/low-stock-scheduler.ts)
   - maintenance sweep               (lib/maintenance-scheduler.ts)
     · stale login-attempt pruning
     · orphaned image-file cleanup
   - stale reservation cleanup       (lib/reservation-scheduler.ts)
     · frees stock locked by abandoned carts/holds
   Skips the intervals under `next dev` and during `next build` —
   those moments get event-triggered + manual runs instead. All three
   schedulers are idempotent and concurrency-safe.
   ═══════════════════════════════════════════════════════════════ */

export async function register() {
  if (process.env["NEXT_RUNTIME"] === "nodejs" && process.env.NODE_ENV === "production") {
    const { startLowStockScheduler } = await import("@/lib/low-stock-scheduler");
    startLowStockScheduler();

    const { startMaintenanceScheduler } = await import("@/lib/maintenance-scheduler");
    startMaintenanceScheduler();

    const { startReservationCleanupScheduler } = await import("@/lib/reservation-scheduler");
    startReservationCleanupScheduler();
  }

  if (process.env["NEXT_RUNTIME"] === "nodejs" && process.env.NODE_ENV === "development") {
    warmupDevRoutes();
  }
}

/* ─── Dev warmup ───
   In `next dev`, the first requests to hit an uncompiled route trigger an
   on-demand compile. When several auth-dependent routes are hit
   simultaneously (browser tab + QA harness + session polling), NextAuth's
   session handling can race the /api/auth/session compile and surface as
   `SyntaxError: Unexpected end of JSON input` → one-off 500s that recover
   on retry. Sequentially warming the auth-critical routes right after boot
   serializes those first compiles so real traffic lands on warm routes. */
function warmupDevRoutes(): void {
  const routes = ["/api/health", "/api/auth/session", "/login", "/api/auth/providers"];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    const base = await resolveDevBase(sleep);
    if (!base) return; // no candidate answered — warmup is best-effort
    for (const route of routes) {
      try {
        await fetch(`${base}${route}`, { redirect: "manual" });
      } catch {
        /* warmup is best-effort */
      }
      await sleep(300);
    }
    console.log(`[warmup] dev routes pre-compiled on ${base} (auth session/login ready)`);
  })();
}

/**
 * Candidate base URLs for the dev server, most-specific first. A stale
 * AUTH_URL (e.g. it still names :3000 while the dev server landed on a
 * different free port) must not stop warmup, so the configured URL is
 * just the first candidate — not the only one.
 */
function devBaseCandidates(): string[] {
  const port = process.env["PORT"];
  const candidates = [
    process.env["AUTH_URL"],
    process.env["NEXTAUTH_URL"],
    port ? `http://localhost:${port}` : undefined,
    "http://localhost:3000",
    "http://localhost:3001",
  ];
  return [...new Set(candidates.filter((url): url is string => Boolean(url)))];
}

/**
 * Return the first candidate that answers /api/health (status < 500),
 * retrying for ~30s so a slow boot is tolerated. Returns null if none
 * come up.
 */
async function resolveDevBase(sleep: (ms: number) => Promise<unknown>): Promise<string | null> {
  const candidates = devBaseCandidates();
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const base of candidates) {
      try {
        // Short timeout so a candidate that accepts the socket but never
        // answers can't stall warmup for the whole retry budget.
        const res = await fetch(`${base}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status < 500) return base;
      } catch {
        /* not listening on this candidate yet */
      }
    }
    await sleep(1000);
  }
  return null;
}
