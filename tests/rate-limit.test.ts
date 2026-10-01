/* ═══════════════════════════════════════════════════════════════
   RATE LIMITER — unit tests
   Runs against an in-memory fake store (no database): email lockout
   after repeated failures, sliding-window expiry, per-IP throttling,
   separate registration budgets, and pruning of stale rows. The store
   and clock are injected per call, so tests are fully parallel-safe.
   Run: npx tsx --test tests/rate-limit.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLoginRateLimit,
  recordLoginAttempt,
  clearLoginFailures,
  clearAttemptsForEmail,
  clearAllAttempts,
  checkRegistrationRateLimit,
  recordRegistrationAttempt,
  pruneLoginAttempts,
  MAX_FAILED_PER_EMAIL,
  MAX_ATTEMPTS_PER_IP,
  MAX_REGISTRATIONS_PER_IP,
  MAX_REGISTRATIONS_PER_EMAIL,
  type RateLimitStore,
  type RateLimitContext,
} from "@/lib/api/rate-limit";

interface Row {
  email: string;
  ip?: string | null;
  kind: string;
  success: boolean;
  createdAt: Date;
}

type Where = Record<string, unknown>;

/**
 * Tiny in-memory Prisma-shaped store with a controllable clock. The
 * returned `ctx` is passed to every limiter call — nothing shared
 * between tests.
 */
function makeEnv(): { ctx: RateLimitContext; rows: Row[]; tick: (ms: number) => void } {
  const rows: Row[] = [];
  let fakeNow = Date.now();
  const now = () => fakeNow;

  const matches = (row: Row, where: Where): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "object" && "lt" in (value as object)) {
        const cmp = (value as { lt: Date }).lt;
        if (!(row[key as keyof Row] instanceof Date) || (row[key as keyof Row] as Date).getTime() >= cmp.getTime()) return false;
      } else if (typeof value === "object" && "gte" in (value as object)) {
        const cmp = (value as { gte: Date }).gte;
        if (!(row[key as keyof Row] instanceof Date) || (row[key as keyof Row] as Date).getTime() < cmp.getTime()) return false;
      } else if (Array.isArray(value)) {
        if (!(value as unknown[]).includes(row[key as keyof Row])) return false;
      } else if (row[key as keyof Row] !== value) {
        return false;
      }
    }
    return true;
  };

  const store: RateLimitStore = {
    loginAttempt: {
      async findMany(args) {
        const filtered = rows.filter((r) => matches(r, args.where));
        filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const taken = args.take ? filtered.slice(0, args.take) : filtered;
        return taken.map((r) => ({ createdAt: r.createdAt }));
      },
      async count(args) {
        return rows.filter((r) => matches(r, args.where)).length;
      },
      async create(args) {
        const d = args.data as {
          email: unknown;
          ip?: unknown;
          kind?: unknown;
          success?: unknown;
        };
        rows.push({
          email: String(d.email),
          ip: d.ip == null ? null : String(d.ip),
          kind: String(d.kind ?? "login"),
          success: Boolean(d.success),
          createdAt: new Date(fakeNow),
        });
        return {};
      },
      async deleteMany(args) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i]!, args.where)) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  };

  return {
    ctx: { store, now },
    rows,
    tick(ms: number) {
      fakeNow += ms;
    },
  };
}

test("email locks after MAX_FAILED_PER_EMAIL consecutive failures", async () => {
  const env = makeEnv();
  const email = "lock@test.com";
  for (let i = 0; i < MAX_FAILED_PER_EMAIL; i++) {
    const r = await checkLoginRateLimit(email, "1.2.3.4", env.ctx);
    assert.equal(r.limited, false, `attempt ${i + 1} should be allowed`);
    await recordLoginAttempt(email, "1.2.3.4", false, env.ctx);
  }
  const blocked = await checkLoginRateLimit(email, "1.2.3.4", env.ctx);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.code, "email_locked");
  assert.ok((blocked.retryAfterSeconds ?? 0) > 0);
});

test("lockout expires when the oldest failure ages out of the window", async () => {
  const env = makeEnv();
  const email = "expire@test.com";
  for (let i = 0; i < MAX_FAILED_PER_EMAIL; i++) {
    await recordLoginAttempt(email, "5.6.7.8", false, env.ctx);
  }
  assert.equal((await checkLoginRateLimit(email, "5.6.7.8", env.ctx)).limited, true);

  // Advance past the lockout window — all failures fall out of range.
  env.tick(16 * 60 * 1000);
  const after = await checkLoginRateLimit(email, "5.6.7.8", env.ctx);
  assert.equal(after.limited, false);
});

test("successful login clears the failure count", async () => {
  const env = makeEnv();
  const email = "clear@test.com";
  for (let i = 0; i < MAX_FAILED_PER_EMAIL; i++) {
    await recordLoginAttempt(email, "9.9.9.9", false, env.ctx);
  }
  await clearLoginFailures(email, env.ctx);
  const r = await checkLoginRateLimit(email, "9.9.9.9", env.ctx);
  assert.equal(r.limited, false);
});

test("IP throttling kicks in after MAX_ATTEMPTS_PER_IP logins", async () => {
  const env = makeEnv();
  const ip = "203.0.113.7";
  for (let i = 0; i < MAX_ATTEMPTS_PER_IP; i++) {
    // different emails, same IP — every attempt counts against the IP
    await recordLoginAttempt(`ip-user-${i}@test.com`, ip, i % 2 === 0, env.ctx);
  }
  const r = await checkLoginRateLimit("brand-new@test.com", ip, env.ctx);
  assert.equal(r.limited, true);
  assert.equal(r.code, "ip_throttled");
});

test("registration budgets are separate from login budgets", async () => {
  const env = makeEnv();
  const email = "reg@test.com";
  const ip = "198.51.100.9";
  for (let i = 0; i < MAX_REGISTRATIONS_PER_IP; i++) {
    await recordRegistrationAttempt(`reg-${i}@test.com`, ip, true, env.ctx);
  }
  const ipBlocked = await checkRegistrationRateLimit(email, ip, env.ctx);
  assert.equal(ipBlocked.limited, true);
  assert.equal(ipBlocked.code, "registration_ip_throttled");

  // The same IP's LOGIN budget is untouched — login is still allowed.
  const loginOk = await checkLoginRateLimit(email, ip, env.ctx);
  assert.equal(loginOk.limited, false);
});

test("per-email registration cap is enforced", async () => {
  const env = makeEnv();
  const email = "same-email@test.com";
  for (let i = 0; i < MAX_REGISTRATIONS_PER_EMAIL; i++) {
    await recordRegistrationAttempt(email, "192.0.2.1", true, env.ctx);
  }
  const r = await checkRegistrationRateLimit(email, "192.0.2.2", env.ctx); // new IP
  assert.equal(r.limited, true);
  assert.equal(r.code, "registration_email_throttled");
});

test("pruneLoginAttempts deletes only rows older than retention", async () => {
  const env = makeEnv();
  // Opportunistic pruning (on record) must not delete fresh rows, but an
  // explicit sweep must clear anything past the retention window.
  await recordLoginAttempt("old@test.com", "1.1.1.1", false, env.ctx);
  env.tick(25 * 60 * 60 * 1000); // 25h later — now old enough to prune

  // No new record: rows sit untouched until the sweep runs.
  assert.equal(env.rows.length, 1);
  const pruned = await pruneLoginAttempts(env.ctx);
  assert.equal(pruned, 1);
  assert.equal(env.rows.length, 0);
});

test("pruneLoginAttempts keeps rows inside the retention window", async () => {
  const env = makeEnv();
  await recordLoginAttempt("fresh@test.com", "1.1.1.1", false, env.ctx);
  env.tick(60 * 60 * 1000); // 1h later — well inside 24h retention
  const pruned = await pruneLoginAttempts(env.ctx);
  assert.equal(pruned, 0);
  assert.equal(env.rows.length, 1);
});

test("opportunistic prune on record clears expired rows", async () => {
  const env = makeEnv();
  await recordLoginAttempt("old@test.com", "1.1.1.1", false, env.ctx);
  env.tick(25 * 60 * 60 * 1000); // 25h later
  // Recording a NEW attempt prunes the expired one as a side effect.
  await recordLoginAttempt("new@test.com", "2.2.2.2", false, env.ctx);
  assert.equal(env.rows.length, 1);
  assert.equal(env.rows[0]!.email, "new@test.com");
});

test("email matching is case-insensitive", async () => {
  const env = makeEnv();
  await recordLoginAttempt("MiXeD@Test.com", "3.3.3.3", false, env.ctx);
  const r = await checkLoginRateLimit("mixed@test.com", "3.3.3.3", env.ctx);
  assert.equal(r.limited, false); // only 1 failure — not locked
});

test("clearAttemptsForEmail unlocks one account and leaves others alone", async () => {
  const env = makeEnv();
  const locked = "locked@test.com";
  for (let i = 0; i < MAX_FAILED_PER_EMAIL; i++) {
    await recordLoginAttempt(locked, "4.4.4.4", false, env.ctx);
  }
  // Also record a registration row for the same email — it must go too.
  await recordRegistrationAttempt(locked, "4.4.4.4", true, env.ctx);
  await recordLoginAttempt("other@test.com", "4.4.4.4", false, env.ctx);

  const removed = await clearAttemptsForEmail(locked, env.ctx);
  assert.equal(removed, MAX_FAILED_PER_EMAIL + 1);
  assert.equal((await checkLoginRateLimit(locked, "4.4.4.4", env.ctx)).limited, false);
  // The unrelated account's row survives.
  assert.equal(env.rows.length, 1);
  assert.equal(env.rows[0]!.email, "other@test.com");
});

test("clearAttemptsForEmail normalizes the address", async () => {
  const env = makeEnv();
  await recordLoginAttempt("mixed@test.com", "6.6.6.6", false, env.ctx);
  const removed = await clearAttemptsForEmail("MiXeD@Test.com", env.ctx);
  assert.equal(removed, 1);
  assert.equal(env.rows.length, 0);
});

test("clearAllAttempts wipes every row regardless of kind or account", async () => {
  const env = makeEnv();
  await recordLoginAttempt("a@test.com", "7.7.7.7", false, env.ctx);
  await recordLoginAttempt("b@test.com", "7.7.7.7", true, env.ctx);
  await recordRegistrationAttempt("c@test.com", "7.7.7.7", true, env.ctx);

  const removed = await clearAllAttempts(env.ctx);
  assert.equal(removed, 3);
  assert.equal(env.rows.length, 0);
});