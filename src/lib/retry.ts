/* ═══════════════════════════════════════════════════════════════
   RETRY HELPER — unique-constraint safe allocation
   Sequential order numbers (POS-20260907-0001, PO-000042…) are derived
   from a COUNT, so two concurrent requests can compute the same number
   and one of them hits a P2002 unique violation. retryOnUniqueConflict
   makes such allocations safe: regenerate (via onConflict) and retry a
   bounded number of times. Pure / DB-agnostic — unit-testable.
   ═══════════════════════════════════════════════════════════════ */

/** A Prisma error carries a `code` string ("P2002" = unique constraint). */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

interface RetryOptions {
  /** Total attempts including the first. Defaults to 3. */
  attempts?: number;
  /** Called after a unique-constraint collision, before retrying —
   *  typically to regenerate the sequential number (fresh count). */
  onConflict?: () => Promise<void> | void;
}

/**
 * Run `run`; when it throws a unique-constraint violation, invoke
 * `onConflict` and retry (up to `attempts` total). Any other error is
 * rethrown immediately so real failures are never masked.
 */
export async function retryOnUniqueConflict<T>(
  run: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isUniqueConstraintError(error) || attempt === attempts - 1) {
        throw error;
      }
      await options.onConflict?.();
    }
  }

  throw lastError;
}
