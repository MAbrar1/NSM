/* ═══════════════════════════════════════════════════════════════
   PRINT INTELLIGENCE — the decision brain on top of the PrintService.
   Analyses context (job kind, terminal, time, profile health, paper
   economy) and decides HOW to print; the PrintService remains the
   only component that touches drivers/transports.

   Intelligence built in:
   1. Smart routing       — receipt → thermal profile, report → A4/A5
                            browser/pdf, label → label profile, with a
                            fallback chain when the primary is offline.
   2. Profile health      — rolling success rate + last error per
                            profile; unhealthy profiles drop down the
                            chain automatically and recover on probe.
   3. Paper economy       — content-aware line-density hints suggest
                            compact/normal/roomy receipt modes; the
                            estimator forecasts roll usage so stores
                            can reorder before the roll runs out.
   4. Duplicate collapse  — the same receipt re-requested within a
                            window is a no-op (double-click guard).
   5. Analytics           — aggregate printable event stream (prints,
                            reprints, failures by profile/hour) for the
                            Print Center dashboard.
   ═══════════════════════════════════════════════════════════════ */

import type { PrintJob } from "./driver";

/* ─── 1. Smart routing ─────────────────────────────────────────── */

export type PrintKind = "receipt" | "report" | "label" | "pdf";

/** Minimal shape of a profile the router can reason about. */
export interface RoutableProfile {
  id: string;
  name: string;
  connectionType: string;
  defaultFor: string | null; // receipt | report | label
  isEnabled: boolean;
  paperWidthMm: number;
}

export interface RoutingTarget {
  profile: RoutableProfile;
  /** Why this target was chosen (for logs + the UI badge). */
  reason: string;
}

export interface RoutingDecision {
  target: RoutingTarget | null;
  /** Ordered fallbacks to try when the target fails. */
  fallbacks: RoutingTarget[];
}

/**
 * Score a profile for a print kind. Deterministic, pure:
 *   +40 defaultFor matches the kind
 *   +15 thermal-ish width for receipts (≤112 mm)
 *   +12 wide sheet for reports (browser profiles)
 *   +8  narrow head for labels
 *   +health score (0–25) — a profile past UNHEALTHY_THRESHOLD scores
 *   -Infinity: it is disqualified from PRIMARY routing (still eligible
 *   as an explicit manual choice) until it probes healthy again.
 */
export function scoreProfile(
  profile: RoutableProfile,
  kind: PrintKind,
  healthScore: number
): number {
  if (!profile.isEnabled || healthScore <= 0) return -Infinity;
  let score = healthScore * 0.25; // 0–25
  if (profile.defaultFor === kind) score += 40;
  if (kind === "receipt" && profile.paperWidthMm <= 112) score += 15;
  if ((kind === "report" || kind === "pdf") && profile.connectionType === "browser") score += 12;
  if (kind === "label" && profile.paperWidthMm <= 58) score += 8;
  return score;
}

/** Route a print job kind to the best profile + fallback chain. */
export function routePrint(
  kind: PrintKind,
  profiles: RoutableProfile[],
  healthScoreOf: (profileId: string) => number
): RoutingDecision {
  const scored = profiles
    .map((p) => ({ profile: p, score: scoreProfile(p, kind, healthScoreOf(p.id)) }))
    .filter((s) => Number.isFinite(s.score))
    .sort((a, b) => b.score - a.score);

  const toTarget = (s: { profile: RoutableProfile } | undefined, reason: string): RoutingTarget | null =>
    s ? { profile: s.profile, reason } : null;

  const target = toTarget(scored[0], scored[0] ? `best score ${scored[0].score.toFixed(0)} for ${kind}` : "");
  const fallbacks = scored.slice(1, 3).map((s) => ({
    profile: s.profile,
    reason: `fallback for ${kind}`,
  }));

  return { target, fallbacks };
}

/* ─── 2. Profile health tracker ────────────────────────────────── */

export interface ProfileHealth {
  attempts: number;
  failures: number;
  consecutiveFailures: number;
  lastError: { code: string; message: string; at: number } | null;
  lastSuccessAt: number | null;
}

const health = new Map<string, ProfileHealth>();
/** A profile goes "unhealthy" after this many consecutive failures. */
export const UNHEALTHY_THRESHOLD = 3;

export function recordPrintSuccess(profileId: string): ProfileHealth {
  const h = health.get(profileId) ?? { attempts: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastSuccessAt: null };
  h.attempts++;
  h.consecutiveFailures = 0;
  h.lastSuccessAt = Date.now();
  health.set(profileId, h);
  return h;
}

export function recordPrintFailure(profileId: string, code: string, message: string): ProfileHealth {
  const h = health.get(profileId) ?? { attempts: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastSuccessAt: null };
  h.attempts++;
  h.failures++;
  h.consecutiveFailures++;
  h.lastError = { code, message, at: Date.now() };
  health.set(profileId, h);
  return h;
}

export function getHealth(profileId: string): ProfileHealth {
  return health.get(profileId) ?? { attempts: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastSuccessAt: null };
}

/** 0–100 success rate (perfect health when unused, so new printers win). */
export function healthScore(profileId: string): number {
  const h = getHealth(profileId);
  if (h.attempts === 0) return 100;
  if (h.consecutiveFailures >= UNHEALTHY_THRESHOLD) return 0;
  return Math.round(((h.attempts - h.failures) / h.attempts) * 100);
}

export function resetHealth(): void {
  health.clear();
}

/* ─── 3. Paper economy + content-aware density ─────────────────── */

export type DensityMode = "compact" | "normal" | "roomy";

/**
 * Choose receipt line density from content shape: long carts get
 * compact spacing so a 100-line receipt stays on one tear-off;
 * tiny receipts get roomy spacing for readability.
 */
export function suggestDensity(itemCount: number): DensityMode {
  if (itemCount >= 30) return "compact";
  if (itemCount <= 3) return "roomy";
  return "normal";
}

/** Millimeters of paper a receipt will consume (203 dpi model). */
export function estimateReceiptLengthMm(itemCount: number, density: DensityMode): number {
  const perLineMm = density === "compact" ? 4.2 : density === "roomy" ? 6.5 : 5.4;
  const fixedMm = 68; // header + totals + payments + footer + fiscal
  return Math.round(fixedMm + itemCount * perLineMm);
}

/** Days of roll left given daily print volume and a 80 m roll. */
export function rollDaysRemaining(dailyReceipts: number, avgItemsPerReceipt: number): number | null {
  if (dailyReceipts <= 0) return null;
  const mmPerDay = dailyReceipts * estimateReceiptLengthMm(avgItemsPerReceipt, "normal");
  const ROLL_MM = 80_000;
  return Math.max(0, Math.round((ROLL_MM / mmPerDay) * 10) / 10);
}

/* ─── 4. Duplicate collapse ────────────────────────────────────── */

const recentRequests = new Map<string, number>();
/** Jobs whose LAST attempt failed — retries must always pass. */
const failedRecently = new Set<string>();
export const DEDUPE_WINDOW_MS = 1500;

/** Test/maintenance hook: forget every recent request. */
export function resetDuplicateWindow(): void {
  recentRequests.clear();
  failedRecently.clear();
}

/**
 * True when this exact job was requested within the dedupe window.
 * A job whose previous attempt FAILED is never suppressed: retrying
 * after a paper jam or offline printer must go straight through.
 */
export function isDuplicateRequest(jobKey: string, now = Date.now()): boolean {
  const last = recentRequests.get(jobKey);
  const isDuplicate =
    last !== undefined &&
    now - last < DEDUPE_WINDOW_MS &&
    !failedRecently.has(jobKey);
  recentRequests.set(jobKey, now);
  // Opportunistic cleanup so the map cannot grow unbounded.
  if (recentRequests.size > 100) {
    for (const [k, at] of recentRequests) {
      if (now - at > 60_000) recentRequests.delete(k);
    }
  }
  return isDuplicate;
}

/** Mark a job's last attempt as failed (retries bypass the dedupe). */
export function markJobFailed(jobKey: string): void {
  failedRecently.add(jobKey);
}

/** Mark a job as succeeded (normal dedupe applies again). */
export function clearJobFailure(jobKey: string): void {
  failedRecently.delete(jobKey);
}

/* ─── 5. Print analytics (client-side aggregation for the dashboard) ── */

export interface PrintEvent {
  profileId: string;
  /** Driver kind of the job (escpos-raster, browser-html, …). */
  kind: string;
  ok: boolean;
  at: number;
  errorCode?: string;
}

const events: PrintEvent[] = [];
export const MAX_EVENTS = 500;

export function recordEvent(evt: PrintEvent): void {
  events.push(evt);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export interface PrintAnalytics {
  total: number;
  ok: number;
  failed: number;
  successRate: number;
  byKind: Record<string, { ok: number; failed: number }>;
  byProfile: Record<string, { ok: number; failed: number }>;
  topErrors: Array<{ code: string; count: number }>;
}

export function analytics(sinceMs: number = 24 * 3600_000): PrintAnalytics {
  const since = Date.now() - sinceMs;
  const byKind: Record<string, { ok: number; failed: number }> = {};
  const byProfile: Record<string, { ok: number; failed: number }> = {};
  const errors = new Map<string, number>();
  let ok = 0;
  let failed = 0;

  for (const e of events) {
    if (e.at < since) continue;
    if (e.ok) ok++;
    else {
      failed++;
      if (e.errorCode) errors.set(e.errorCode, (errors.get(e.errorCode) ?? 0) + 1);
    }
    const kind = (byKind[e.kind] ??= { ok: 0, failed: 0 });
    kind[e.ok ? "ok" : "failed"]++;
    const prof = (byProfile[e.profileId] ??= { ok: 0, failed: 0 });
    prof[e.ok ? "ok" : "failed"]++;
  }

  const total = ok + failed;
  return {
    total,
    ok,
    failed,
    successRate: total === 0 ? 100 : Math.round((ok / total) * 100),
    byKind,
    byProfile,
    topErrors: [...errors.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

/** Exported for the Print Center UI: the job kind → driver kind map. */
export function driverKindFor(kind: PrintKind): PrintJob["kind"] {
  switch (kind) {
    case "receipt":
    case "label":
      return "escpos-raster";
    case "report":
      return "browser-html";
    case "pdf":
      return "pdf";
  }
}
