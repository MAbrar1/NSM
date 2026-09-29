/* ═══════════════════════════════════════════════════════════════
   QUERY DATE PARSER — unit tests
   Guards the bug this helper eliminated: a malformed date param
   (the literal "null" a stale refunds drill-down link sent) built
   an Invalid Date, which Prisma rejected with a 500 and took the
   reports/refunds pages down. Garbage must degrade to "no filter".
   Run: npx tsx --test tests/query-date.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQueryDateStart, parseQueryDateEnd } from "@/lib/query-date";

test("valid YYYY-MM-DD parses to local start/end of day", () => {
  const start = parseQueryDateStart("2026-09-26");
  assert.ok(start);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 8);
  assert.equal(start.getDate(), 26);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);

  const end = parseQueryDateEnd("2026-09-26");
  assert.ok(end);
  assert.equal(end.getDate(), 26);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
  assert.equal(end.getSeconds(), 59);
  assert.equal(end.getMilliseconds(), 999);
});

test("missing / empty params are null (no filter)", () => {
  assert.equal(parseQueryDateStart(null), null);
  assert.equal(parseQueryDateStart(undefined), null);
  assert.equal(parseQueryDateStart(""), null);
  assert.equal(parseQueryDateEnd(null), null);
  assert.equal(parseQueryDateEnd(""), null);
});

test("the literal string \"null\" is rejected (the production 500)", () => {
  assert.equal(parseQueryDateStart("null"), null);
  assert.equal(parseQueryDateEnd("null"), null);
  assert.equal(parseQueryDateStart("undefined"), null);
  assert.equal(parseQueryDateEnd("undefined"), null);
});

test("garbage / wrong shapes are rejected", () => {
  assert.equal(parseQueryDateStart("not-a-date"), null);
  assert.equal(parseQueryDateStart("2026/09/26"), null);
  assert.equal(parseQueryDateStart("26-09-2026"), null);
  assert.equal(parseQueryDateStart("2026-9-6"), null);
  assert.equal(parseQueryDateEnd("2026-09-26T12:00:00"), null);
});

test("impossible calendar days are rejected (no silent roll-forward)", () => {
  assert.equal(parseQueryDateStart("2026-02-31"), null);
  assert.equal(parseQueryDateStart("2026-13-01"), null);
  assert.equal(parseQueryDateStart("2026-00-10"), null);
  assert.equal(parseQueryDateStart("2026-04-31"), null);
});

test("leap days are accepted only in leap years", () => {
  assert.ok(parseQueryDateStart("2024-02-29"));
  assert.equal(parseQueryDateStart("2025-02-29"), null);
});
