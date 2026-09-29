/* ═══════════════════════════════════════════════════════════════
   PAGINATION PARSER — unit tests
   Guards the two defects this helper eliminated from the list
   routes: NaN page/pageSize crashing Prisma (`skip: NaN`), and
   uncapped pageSize letting one request read the whole table.
   Run: npx tsx --test tests/pagination.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePagination } from "@/lib/pagination";

function params(entries: Record<string, string>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) sp.set(k, v);
  return sp;
}

test("defaults apply when params are missing", () => {
  const p = parsePagination(params({}));
  assert.deepEqual(
    { page: p.page, pageSize: p.pageSize, skip: p.skip, take: p.take },
    { page: 1, pageSize: 20, skip: 0, take: 20 }
  );
});

test("valid params pass through", () => {
  const p = parsePagination(params({ page: "3", pageSize: "50" }));
  assert.equal(p.page, 3);
  assert.equal(p.pageSize, 50);
  assert.equal(p.skip, 100);
  assert.equal(p.take, 50);
});

test("NaN / garbage values fall back to defaults (no Prisma crash)", () => {
  const p = parsePagination(params({ page: "abc", pageSize: "xyz" }));
  assert.equal(p.page, 1);
  assert.equal(p.pageSize, 20);

  const p2 = parsePagination(params({ page: "", pageSize: "" }));
  assert.equal(p2.page, 1);
  assert.equal(p2.pageSize, 20);

  // Huge-but-numeric values are clamped, not passed through.
  const p3 = parsePagination(params({ pageSize: "999999999999" }));
  assert.equal(p3.pageSize, 100);
});

test("page is pulled up to 1 and pageSize clamped to [1, max]", () => {
  const p = parsePagination(params({ page: "-5", pageSize: "0" }));
  assert.equal(p.page, 1);
  assert.equal(p.pageSize, 1);

  const p2 = parsePagination(params({ page: "0", pageSize: "999999" }));
  assert.equal(p2.page, 1);
  assert.equal(p2.pageSize, 100);
});

test("maxPageSize option caps the size", () => {
  const p = parsePagination(params({ pageSize: "999" }), { maxPageSize: 50 });
  assert.equal(p.pageSize, 50);
});

test("custom pageSizeParam reads `limit` (legacy routes)", () => {
  const p = parsePagination(params({ page: "2", limit: "30" }), {
    pageSizeParam: "limit",
    defaultPageSize: 20,
  });
  assert.equal(p.page, 2);
  assert.equal(p.pageSize, 30);
  assert.equal(p.skip, 30);
  // ...and ignores pageSize when param name is `limit`
  const p2 = parsePagination(params({ pageSize: "77", limit: "10" }), {
    pageSizeParam: "limit",
  });
  assert.equal(p2.pageSize, 10);
});

test("custom defaultPageSize", () => {
  const p = parsePagination(params({}), { defaultPageSize: 50 });
  assert.equal(p.pageSize, 50);
});
