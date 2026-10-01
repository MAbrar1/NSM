/* ═══════════════════════════════════════════════════════════════
   SEED API GUARD — regression tests
   /api/seed wipes and repopulates every table. The route must refuse
   to run unless SEED_API_KEY is configured AND supplied via the
   `x-seed-key` header, and must always refuse in production. These
   tests only exercise the refusal paths — the success path would
   actually re-seed the database, so it is intentionally not invoked.
   Run: npx tsx --test tests/seed-guard.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/seed/route";
import { hasPermission, type Role } from "@/lib/auth/rbac";

/* @types/node marks NODE_ENV read-only; mutate through an indexable
   view of process.env so the test can stage each guard condition. */
const env = process.env as Record<string, string | undefined>;

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/seed", { method: "POST", headers });
}

interface EnvSnapshot {
  nodeEnv: string | undefined;
  seedKey: string | undefined;
}

function snapshot(): EnvSnapshot {
  return { nodeEnv: env["NODE_ENV"], seedKey: env["SEED_API_KEY"] };
}

function restore(snap: EnvSnapshot): void {
  if (snap.nodeEnv === undefined) delete env["NODE_ENV"];
  else env["NODE_ENV"] = snap.nodeEnv;
  if (snap.seedKey === undefined) delete env["SEED_API_KEY"];
  else env["SEED_API_KEY"] = snap.seedKey;
}

test("fails closed when SEED_API_KEY is not configured", async () => {
  const snap = snapshot();
  delete env["SEED_API_KEY"];
  env["NODE_ENV"] = "development";
  try {
    const res = await POST(post());
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /disabled/i);
  } finally {
    restore(snap);
  }
});

test("rejects a wrong x-seed-key header", async () => {
  const snap = snapshot();
  env["NODE_ENV"] = "development";
  env["SEED_API_KEY"] = "unit-test-secret";
  try {
    const res = await POST(post({ "x-seed-key": "not-the-key" }));
    assert.equal(res.status, 403);
  } finally {
    restore(snap);
  }
});

test("is disabled in production even with the correct key", async () => {
  const snap = snapshot();
  env["NODE_ENV"] = "production";
  env["SEED_API_KEY"] = "unit-test-secret";
  try {
    const res = await POST(post({ "x-seed-key": "unit-test-secret" }));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /production/i);
  } finally {
    restore(snap);
  }
});

test("a valid key alone is not enough — an admin session is required", async () => {
  const snap = snapshot();
  env["NODE_ENV"] = "development";
  env["SEED_API_KEY"] = "unit-test-secret";
  try {
    // No session in this unit context: the route must reject rather than
    // reach the destructive runSeed() path.
    const res = await POST(post({ "x-seed-key": "unit-test-secret" }));
    assert.equal(res.status, 401);
  } finally {
    restore(snap);
  }
});

test("settings:edit isolates the seed gate to admins", () => {
  const allowed: Role[] = ["super_admin", "admin"];
  const denied: Role[] = ["manager", "cashier", "inventory_clerk", "viewer"];
  for (const role of allowed) {
    assert.equal(hasPermission(role, "settings:edit"), true, `${role} should be allowed`);
  }
  for (const role of denied) {
    assert.equal(hasPermission(role, "settings:edit"), false, `${role} should be denied`);
  }
});

test("GET advertises the disabled state when no key is configured", async () => {
  const snap = snapshot();
  delete env["SEED_API_KEY"];
  env["NODE_ENV"] = "development";
  try {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hint?: string };
    assert.match(body.hint ?? "", /disabled/i);
  } finally {
    restore(snap);
  }
});
