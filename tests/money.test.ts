/* ═══════════════════════════════════════════════════════════════
   MONEY — unit tests
   Locks the single cents↔major conversions and the CSV money-cell
   parser shared by every product/variant route, both CSV importers,
   the bulk price adjuster and the export toolkit. Those sites used
   to re-type `Math.round(x * 100)` and a hand-rolled cell parser,
   so the same input could store different cents per entry point.
   Run: npx tsx --test tests/money.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centsToMajorString,
  clampToInt,
  majorToCents,
  parseMoneyToCents,
  roundHalfUp,
} from "@/lib/money/money";

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

test("parseMoneyToCents: huge and Infinity cells cannot poison a cents column", () => {
  // A hand-edited CSV cell used to surface parseFloat()'s 1e13 * 100 float
  // verbatim into an Int column; it now saturates like every other entry.
  assert.equal(parseMoneyToCents("99999999999.99"), 2147483647);
  assert.equal(parseMoneyToCents("Infinity"), null);
  assert.equal(parseMoneyToCents("NaN"), null);
});

test("parseMoneyToCents and majorToCents agree on the same value", () => {
  assert.equal(parseMoneyToCents("12.50"), majorToCents(12.5));
  assert.equal(parseMoneyToCents("0.99"), majorToCents(0.99));
});

test("centsToMajorString: returns the major string, never recurses", () => {
  // Regression: the dedup wave shipped this helper as
  // `return centsToMajorString(cents)` — a self-call with no base case,
  // so EVERY call was a guaranteed RangeError. POS cold navigation hit
  // it through currency-core and the page died before the header
  // rendered. If it ever recurses again, these calls throw.
  assert.equal(centsToMajorString(12345), "123.45");
  assert.equal(centsToMajorString(0), "0.00");
  assert.equal(centsToMajorString(5), "0.05");
  assert.equal(centsToMajorString(199999), "1999.99");
});

test("centsToMajorString is the inverse of majorToCents", () => {
  for (const cents of [0, 1, 99, 1250, 199999]) {
    assert.equal(majorToCents(Number(centsToMajorString(cents))), cents);
  }
});

test("centsToMajorString: non-finite input renders 0.00, never NaN text", () => {
  // A poisoned cents value reaching the export path must not write
  // "NaN" into an Excel money cell.
  assert.equal(centsToMajorString(Number.NaN), "0.00");
  assert.equal(centsToMajorString(Number.POSITIVE_INFINITY), "0.00");
  assert.equal(centsToMajorString(Number.NEGATIVE_INFINITY), "0.00");
});

test("majorToCents: out-of-range conversions saturate at Prisma Int bounds", () => {
  // 2^31-1 is the largest value an Int cents column accepts; beyond it
  // the write would fail mid-transaction. Saturation beats a throw here
  // because the alternative (silently wrapping the float) is worse.
  assert.equal(majorToCents(1e12), 2147483647);
  assert.equal(majorToCents(21474836.47), 2147483647);
  assert.equal(majorToCents(-1e12), -2147483647);
  // Just inside the bounds, conversion is exact.
  assert.equal(majorToCents(21474836.46), 2147483646);
});

test("majorToCents: results are always integers", () => {
  // Float residue (0.1 + 0.2) must never reach a cents column.
  assert.equal(majorToCents(0.1 + 0.2), 30);
  assert.equal(Number.isInteger(majorToCents(19.99)), true);
});

test("roundHalfUp: Math.round's rule, total over non-finite input", () => {
  assert.equal(roundHalfUp(12.5), 13);
  assert.equal(roundHalfUp(-12.5), -12);
  assert.equal(roundHalfUp(12.4), 12);
  assert.equal(roundHalfUp(Number.NaN), 0);
  assert.equal(roundHalfUp(Number.POSITIVE_INFINITY), 0);
});

test("clampToInt: saturates at ±(2^31-1), NaN resolves to 0", () => {
  assert.equal(clampToInt(3e9), 2147483647);
  assert.equal(clampToInt(-3e9), -2147483647);
  assert.equal(clampToInt(1234), 1234);
  assert.equal(clampToInt(Number.NaN), 0);
  assert.equal(clampToInt(Number.POSITIVE_INFINITY), 2147483647);
});
