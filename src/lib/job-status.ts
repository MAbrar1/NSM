/* ═══════════════════════════════════════════════════════════════
   BACKGROUND JOB STATUS (in-process registry)
   The scheduled jobs (low-stock scan, maintenance sweep, stale-
   reservation cleanup) used to report only to the server console.
   This registry records every run so the Settings screen can show
   "last ran 4 minutes ago — released 2 stale reservations" and a
   manual trigger can prove it worked.

   Scope: in-memory, per server process. It resets on restart and
   says nothing about *other* instances behind a load balancer —
   for durable observability ship logs to a log service. It is a
   status card, not an APM system.
   ═══════════════════════════════════════════════════════════════ */

export type JobName =
  | "low-stock-scan"
  | "maintenance-sweep"
  | "reservation-cleanup";

/** What triggered the run. */
export type JobSource = "scheduler" | "manual" | "cron";

/** JSON primitives the registry can hold. */
type JsonPrimitive = string | number | boolean | null;

/** Serializable facts about a run's outcome (sanitized, see below). */
export type JobSummaryValue = JsonPrimitive | JsonPrimitive[];

export interface JobRunRecord {
  job: JobName;
  source: JobSource;
  startedAt: string; // ISO timestamp
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  /** JSON-safe facts about the run's outcome. */
  summary: Record<string, JobSummaryValue>;
  error?: string;
}

/** How many past runs are kept per job (most recent first when read). */
const HISTORY_LIMIT = 10;

const globalForJobs = globalThis as unknown as {
  __posJobRuns: Map<JobName, JobRunRecord[]> | undefined;
};

function store(): Map<JobName, JobRunRecord[]> {
  if (!globalForJobs.__posJobRuns) {
    globalForJobs.__posJobRuns = new Map();
  }
  return globalForJobs.__posJobRuns;
}

/** Most recent run of a job, or null when the job has never run. */
export function lastJobRun(job: JobName): JobRunRecord | null {
  const latest = store().get(job)?.[0];
  return latest ?? null;
}

/** Full (most-recent-first) run history for a job. */
export function jobRunHistory(job: JobName): JobRunRecord[] {
  return store().get(job) ?? [];
}

/** Snapshot of every tracked job's last run — shaped for the API. */
export function jobStatusSnapshot(): Array<{
  job: JobName;
  lastRun: JobRunRecord | null;
  historySize: number;
}> {
  const jobs: JobName[] = [
    "low-stock-scan",
    "maintenance-sweep",
    "reservation-cleanup",
  ];
  return jobs.map((job) => ({
    job,
    lastRun: lastJobRun(job),
    historySize: jobRunHistory(job).length,
  }));
}

function record(run: JobRunRecord): void {
  const runs = store();
  const existing = runs.get(run.job) ?? [];
  existing.unshift(run);
  runs.set(run.job, existing.slice(0, HISTORY_LIMIT));
}

/**
 * Reduce an arbitrary job result to JSON-safe primitives for the
 * registry: primitives pass through, arrays of primitives pass
 * through, nested objects/functions are dropped. Status cards need
 * facts, not object graphs.
 */
function sanitizeSummary(result: object): Record<string, JobSummaryValue> {
  const out: Record<string, JobSummaryValue> = {};
  for (const [key, value] of Object.entries(result)) {
    const v: unknown = value;
    if (
      typeof v === "number" ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      v === null
    ) {
      out[key] = v;
    } else if (Array.isArray(v)) {
      const allPrimitive = v.every(
        (item) =>
          typeof item === "number" ||
          typeof item === "string" ||
          typeof item === "boolean" ||
          item === null
      );
      if (allPrimitive) out[key] = v as JsonPrimitive[];
    }
  }
  return out;
}

/**
 * Run a job and record its outcome. Never throws — a failing job is
 * recorded with ok:false + the error message and the scheduler's
 * fire-and-forget semantics are preserved. The caller receives the
 * job's own typed result (or null on failure), so schedulers keep
 * full type safety over concrete result types like MaintenanceResult.
 */
export async function runTrackedJob<T extends object>(
  job: JobName,
  source: JobSource,
  run: () => Promise<T>
): Promise<T | null> {
  const startedAt = new Date();
  try {
    const result = await run();
    record({
      job,
      source,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      ok: true,
      summary: sanitizeSummary(result),
    });
    return result;
  } catch (err) {
    record({
      job,
      source,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      ok: false,
      summary: {},
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
