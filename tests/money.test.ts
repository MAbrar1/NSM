/* ═══════════════════════════════════════════════════════════════
   MONEY — unit tests
   Locks the single major→cents conversion and the CSV money-cell
   parser shared by every product/variant route, both CSV importers,
   the bulk price adjuster and the export toolkit. Those sites used
   to re-type `Math.round(x * 100)` and a hand-rolled cell parser,
   so the same input could store different cents per entry point.
   Run: npx tsx --test tests/money.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { majorToCents, parseMoneyToCents } from "@/lib/money/money";

test("majorToCents: whole and decimal amounts", () => {
  assert.equal(majorToCents(0), 0);
  assert.equal(majorToCents(7), 700);
  assert.equal(majorToCents(12.5), 1250);
  assert.equal(majorToCents(19.99), 1999);
  assert.equal(majorToCents(1234.56), 123456);
});

test("majorToCents: rounds to the nearest cent", () => {
  assert.equal(majorToCents(12.345), 1235); // .5 up
  assert.equal(majorToCents(12.344), 1234); // .4 down
  assert.equal(majorToCents(0.005), 1);
  assert.equal(majorToCents(0.004), 0);
});

test("majorToCents: non-finite input becomes 0, never NaN", () => {
  // A NaN written to an Int cents column would poison every later sum.
  assert.equal(majorToCents(Number.NaN), 0);
  assert.equal(majorToCents(Number.POSITIVE_INFINITY), 0);
  assert.equal(majorToCents(Number.NEGATIVE_INFINITY), 0);
});

test("parseMoneyToCents: plain and formatted cells", () => {
  assert.equal(parseMoneyToCents("7"), 700);
  assert.equal(parseMoneyToCents("12.50"), 1250);
  assert.equal(parseMoneyToCents("$1,234.50"), 123450);
  assert.equal(parseMoneyToCents(" 1,000.00 "), 100000);
});

test("parseMoneyToCents: commas are thousands separators", () => {
  assert.equal(parseMoneyToCents("12,50"), 125000);
});

test("parseMoneyToCents: empty and unparseable cells are null", () => {
  assert.equal(parseMoneyToCents(""), null);
  assert.equal(parseMoneyToCents("   "), null);
  assert.equal(parseMoneyToCents("abc"), null);
  assert.equal(parseMoneyToCents("$"), null);
  assert.equal(parseMoneyToCents(undefined), null);
});

test("parseMoneyToCents: negative cells are rejected, not negated", () => {
  // A negative price in a CSV is a malformed row, not a credit.
  assert.equal(parseMoneyToCents("-5"), null);
  assert.equal(parseMoneyToCents("-$12.00"), null);
});

test("parseMoneyToCents and majorToCents agree on the same value", () => {
  assert.equal(parseMoneyToCents("12.50"), majorToCents(12.5));
  assert.equal(parseMoneyToCents("0.99"), majorToCents(0.99));
});
