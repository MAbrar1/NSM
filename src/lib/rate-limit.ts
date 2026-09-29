import { db as prismaDb } from "@/lib/db";

/**
 * Minimal store surface the rate limiter touches — injectable so unit
 * tests can run without a database (see tests/rate-limit.test.ts).
 */
export interface RateLimitStore {
  loginAttempt: {
    findMany(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
      orderBy?: Record<string, string>;
      take?: number;
    }): Promise<Array<{ createdAt: Date }>>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

/** The active store — swapped by tests, defaults to the real Prisma client. */
let store: RateLimitStore = prismaDb as unknown as RateLimitStore;

export function setRateLimitStore(next: RateLimitStore): void {
  store = next;
}

export function getRateLimitStore(): RateLimitStore {
  return store;
}

/** Clock source — injectable so tests can advance time deterministically. */
let clock: () => number = () => Date.now();

export function setRateLimitClock(next: () => number): void {
  clock = next;
}

export function resetRateLimitClock(): void {
  clock = () => Date.now();
}

function nowMs(): number {
  return clock();
}

/* ═══════════════════════════════════════════════════════════════
   AUTH RATE LIMITING & LOCKOUT
   Database-backed attempt tracking for login and registration so
   the policy survives server restarts and multiple processes:

   - Login: an email is LOCKED for 15 minutes after 5 consecutive
     failed attempts (sliding window), and brute-force traffic is
     throttled per IP (40 login requests / 10 min).
   - Registration: throttled per IP (10 registrations / hour) and
     per email (3 registrations / hour) to stop signup spam.
   - Rows older than 24h are pruned opportunistically while recording
     a new attempt, so the table never grows unbounded.

   Login and registration attempts are counted separately (`kind`),
   so a heavy login day can't silently block legitimate signups.

   All functions are pure-DB (Node runtime only — never import from
   middleware/edge code).
   ═══════════════════════════════════════════════════════════════ */

/** Max failed attempts per email inside the lockout window. */
export const MAX_FAILED_PER_EMAIL = 5;
/** How long an email stays locked after hitting the failure cap. */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
/** Per-IP auth-request budget inside the IP window (login attempts). */
export const MAX_ATTEMPTS_PER_IP = 40;
export const IP_WINDOW_MS = 10 * 60 * 1000;
/** Registration budgets. */
export const MAX_REGISTRATIONS_PER_IP = 10;
export const MAX_REGISTRATIONS_PER_EMAIL = 3;
export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
/** How long attempt rows are kept before pruning. */
export const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Reasons a LOGIN attempt can be blocked (surfaced to the client as a code). */
export type LoginRateLimitCode = "email_locked" | "ip_throttled";
/** Reasons a REGISTRATION attempt can be blocked. */
export type RegistrationRateLimitCode =
  | "registration_ip_throttled"
  | "registration_email_throttled";

export interface RateLimitResult {
  limited: boolean;
  /** Why the request was rejected (stable code for client messages). */
  code?: LoginRateLimitCode | RegistrationRateLimitCode;
  /** Seconds until the limit resets (for the Retry-After header). */
  retryAfterSeconds?: number;
}

/** Best-effort client IP from the request headers. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Prune rows older than the retention window (indexed delete). */
async function pruneAttempts(c?: RateLimitContext): Promise<void> {
  await pruneLoginAttempts(c);
}

/** Reset the store + clock to production defaults (test teardown). */
export function resetRateLimitStore(): void {
  store = prismaDb as unknown as RateLimitStore;
  resetRateLimitClock();
}

/** Injectable context — tests pass their own store + clock. */
export interface RateLimitContext {
  store?: RateLimitStore;
  /** Millisecond clock. */
  now?: () => number;
}

/** Resolve the store/clock for a call (defaults to production globals). */
function ctx(c?: RateLimitContext): Required<RateLimitContext> {
  return { store: c?.store ?? store, now: c?.now ?? nowMs };
}

/**
 * Delete attempt rows older than the retention window. Also called by
 * the periodic maintenance sweep so the table stays bounded even when
 * no new auth traffic arrives (opportunistic pruning only runs on
 * record).
 */
export async function pruneLoginAttempts(
  c?: RateLimitContext
): Promise<number> {
  const { store, now } = ctx(c);
  const cutoff = new Date(now() - ATTEMPT_RETENTION_MS);
  const res = await store.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}

/**
 * Check whether a login attempt is currently blocked.
 * - `email_locked`: too many recent failures for this email.
 * - `ip_throttled`: this IP has made too many login requests lately.
 */
export async function checkLoginRateLimit(
  email: string,
  ip: string | null,
  c?: RateLimitContext
): Promise<RateLimitResult> {
  const { store, now } = ctx(c);
  const emailKey = normalizeEmail(email);

  const [failures, ipAttempts] = await Promise.all([
    store.loginAttempt.findMany({
      where: {
        email: emailKey,
        kind: "login",
        success: false,
        createdAt: { gte: new Date(now() - LOCKOUT_WINDOW_MS) },
      },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
      take: MAX_FAILED_PER_EMAIL,
    }),
    ip
      ? store.loginAttempt.count({
          where: {
            ip,
            kind: "login",
            createdAt: { gte: new Date(now() - IP_WINDOW_MS) },
          },
        })
      : Promise.resolve(0),
  ]);

  if (failures.length >= MAX_FAILED_PER_EMAIL) {
    // Locked until the oldest failure in the window ages out.
    const oldest = failures[0]!.createdAt.getTime();
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((LOCKOUT_WINDOW_MS - (now() - oldest)) / 1000)
    );
    return { limited: true, code: "email_locked", retryAfterSeconds };
  }

  if (ip && ipAttempts >= MAX_ATTEMPTS_PER_IP) {
    return { limited: true, code: "ip_throttled", retryAfterSeconds: Math.ceil(IP_WINDOW_MS / 1000) };
  }

  return { limited: false };
}

/** Record a login attempt (success or failure) and prune old rows. */
export async function recordLoginAttempt(
  email: string,
  ip: string | null,
  success: boolean,
  c?: RateLimitContext
): Promise<void> {
  const { store, now } = ctx(c);
  const emailKey = normalizeEmail(email);
  await store.loginAttempt.create({ data: { email: emailKey, ip, kind: "login", success } });
  // Opportunistic pruning — the delete is index-backed and bounded.
  await pruneAttempts({ store, now });
}

/** Remove all recorded failures for an email after a successful login. */
export async function clearLoginFailures(
  email: string,
  c?: RateLimitContext
): Promise<void> {
  const { store } = ctx(c);
  await store.loginAttempt.deleteMany({
    where: { email: normalizeEmail(email), kind: "login", success: false },
  });
}

/**
 * Delete every recorded attempt row for one email — login and
 * registration, successful or failed, regardless of age. This is the
 * "unlock this account now" escape hatch used by the CLI when an
 * operator has locked themselves out and can't wait for the window to
 * age out. Returns how many rows were removed.
 */
export async function clearAttemptsForEmail(
  email: string,
  c?: RateLimitContext
): Promise<number> {
  const { store } = ctx(c);
  const res = await store.loginAttempt.deleteMany({
    where: { email: normalizeEmail(email) },
  });
  return res.count;
}

/** Delete every attempt row for every account — a full rate-limit reset. */
export async function clearAllAttempts(c?: RateLimitContext): Promise<number> {
  const { store } = ctx(c);
  const res = await store.loginAttempt.deleteMany({ where: {} });
  return res.count;
}

/** Check registration throttling (per IP and per email). */
export async function checkRegistrationRateLimit(
  email: string,
  ip: string | null,
  c?: RateLimitContext
): Promise<RateLimitResult> {
  const { store, now } = ctx(c);
  const emailKey = normalizeEmail(email);
  const windowStart = new Date(now() - REGISTRATION_WINDOW_MS);

  const [ipCount, emailCount] = await Promise.all([
    ip
      ? store.loginAttempt.count({ where: { ip, kind: "register", createdAt: { gte: windowStart } } })
      : Promise.resolve(0),
    store.loginAttempt.count({ where: { email: emailKey, kind: "register", createdAt: { gte: windowStart } } }),
  ]);

  if (ip && ipCount >= MAX_REGISTRATIONS_PER_IP) {
    return { limited: true, code: "registration_ip_throttled", retryAfterSeconds: Math.ceil(REGISTRATION_WINDOW_MS / 1000) };
  }
  if (emailCount >= MAX_REGISTRATIONS_PER_EMAIL) {
    return { limited: true, code: "registration_email_throttled", retryAfterSeconds: Math.ceil(REGISTRATION_WINDOW_MS / 1000) };
  }
  return { limited: false };
}

/** Record a registration attempt (success or failure) + prune. */
export async function recordRegistrationAttempt(
  email: string,
  ip: string | null,
  success: boolean,
  c?: RateLimitContext
): Promise<void> {
  const { store, now } = ctx(c);
  await store.loginAttempt.create({
    data: { email: normalizeEmail(email), ip, kind: "register", success },
  });
  await pruneAttempts({ store, now });
}