/* ═══════════════════════════════════════════════════════════════
   RETRY HELPER — unit tests
   Covers retry-on-unique-conflict semantics: rethrows non-P2002 errors
   immediately, retries only P2002, regenerates between attempts, and
   gives up after the bounded attempt count.
   Run: npx tsx --test tests/retry.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { retryOnUniqueConflict, isUniqueConstraintError } from "@/lib/retry";

/** Fake Prisma-style unique-constraint error. */
const p2002 = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

test("isUniqueConstraintError recognizes P2002 only", () => {
  assert.equal(isUniqueConstraintError(p2002()), true);
  assert.equal(isUniqueConstraintError(new Error("boom")), false);
  assert.equal(isUniqueConstraintError({ code: "P2002" }), true);
  assert.equal(isUniqueConstraintError(null), false);
  assert.equal(isUniqueConstraintError("P2002"), false);
});

test("succeeds on the first attempt without retrying", async () => {
  let calls = 0;
  const out = await retryOnUniqueConflict(async () => {
    calls++;
    return "ok";
  });
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("retries after a P2002 collision and returns the eventual result", async () => {
  let calls = 0;
  let conflicts = 0;
  const out = await retryOnUniqueConflict(
    async () => {
      calls++;
      if (calls < 3) throw p2002();
      return "won";
    },
    { onConflict: () => void conflicts++ }
  );
  assert.equal(out, "won");
  assert.equal(calls, 3);
  assert.equal(conflicts, 2);
});

test("regenerates the value between attempts via onConflict", async () => {
  const seen: string[] = [];
  const out = await retryOnUniqueConflict(
    async () => {
      const current = seen.length + 1;
      seen.push(`attempt-${current}`);
      if (current === 1) throw p2002();
      return `value-${current}`;
    },
    { attempts: 2 }
  );
  assert.equal(out, "value-2");
  assert.deepEqual(seen, ["attempt-1", "attempt-2"]);
});

test("non-constraint errors are rethrown immediately — never masked", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnUniqueConflict(async () => {
      calls++;
      throw new Error("db down");
    }),
    /db down/
  );
  assert.equal(calls, 1);
});

test("exhausts attempts on persistent collisions and surfaces the last error", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnUniqueConflict(async () => {
      calls++;
      throw p2002();
    }),
    (err: unknown) => isUniqueConstraintError(err)
  );
  assert.equal(calls, 3); // default attempts = 3
});

test("custom attempt budget is honored", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnUniqueConflict(
      async () => {
        calls++;
        throw p2002();
      },
      { attempts: 5 }
    ),
    (err: unknown) => isUniqueConstraintError(err)
  );
  assert.equal(calls, 5);
});
