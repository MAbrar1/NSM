/* ═══════════════════════════════════════════════════════════════
   PRINT INTELLIGENCE — unit tests
   Locks the routing brain, health degradation/recovery, duplicate
   collapse, paper economy and analytics aggregation.
   Run: npx tsx --test tests/print-intelligence.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreProfile,
  routePrint,
  recordPrintSuccess,
  recordPrintFailure,
  healthScore,
  getHealth,
  resetHealth,
  UNHEALTHY_THRESHOLD,
  markJobFailed,
  clearJobFailure,
  suggestDensity,
  estimateReceiptLengthMm,
  rollDaysRemaining,
  isDuplicateRequest,
  analytics,
  recordEvent,
  type RoutableProfile,
} from "@/lib/print/print-intelligence";

const thermal: RoutableProfile = {
  id: "p-thermal",
  name: "Counter 80mm",
  connectionType: "webusb",
  defaultFor: "receipt",
  isEnabled: true,
  paperWidthMm: 80,
};
const sheet: RoutableProfile = {
  id: "p-sheet",
  name: "Office A4",
  connectionType: "browser",
  defaultFor: "report",
  isEnabled: true,
  paperWidthMm: 210,
};
const disabled: RoutableProfile = { ...thermal, id: "p-off", name: "Broken", isEnabled: false, defaultFor: "receipt" };

test("routing: receipt prefers the default thermal profile; disabled never wins", () => {
  resetHealth();
  const decision = routePrint("receipt", [sheet, disabled, thermal], () => 100);
  assert.equal(decision.target!.profile.id, "p-thermal");
  assert.ok(decision.fallbacks.every((f) => f.profile.isEnabled));
});

test("routing: report prefers the browser/A4 profile", () => {
  resetHealth();
  const decision = routePrint("report", [thermal, sheet], () => 100);
  assert.equal(decision.target!.profile.id, "p-sheet");
});

test("health: consecutive failures degrade the score to 0 and demote the profile", () => {
  resetHealth();
  for (let i = 0; i < UNHEALTHY_THRESHOLD; i++) {
    recordPrintFailure("p-thermal", "OFFLINE", "no device");
  }
  assert.equal(healthScore("p-thermal"), 0);
  const decision = routePrint("receipt", [thermal, sheet], healthScore);
  // The A4 sheet (no receipt bonus) now outranks a dead thermal.
  assert.equal(decision.target!.profile.id, "p-sheet");
});

test("health: a success resets consecutive failures and recovers", () => {
  resetHealth();
  recordPrintFailure("p-thermal", "OFFLINE", "x");
  recordPrintFailure("p-thermal", "OFFLINE", "x");
  recordPrintSuccess("p-thermal");
  const h = getHealth("p-thermal");
  assert.equal(h.consecutiveFailures, 0);
  assert.ok(healthScore("p-thermal") > 0);
});

test("unused profiles have perfect health", () => {
  resetHealth();
  assert.equal(healthScore("never-seen"), 100);
});

test("duplicate collapse: same key inside the window is a duplicate", () => {
  resetHealth();
  const t = Date.now();
  assert.equal(isDuplicateRequest("r1", t), false, "first request passes");
  assert.equal(isDuplicateRequest("r1", t + 100), true, "same key inside window");
  assert.equal(isDuplicateRequest("r2", t + 100), false, "different key passes");
});

test("duplicate collapse: a FAILED job is never suppressed on retry", () => {
  resetHealth();
  const t = Date.now();
  assert.equal(isDuplicateRequest("r9", t), false);
  markJobFailed("r9"); // first attempt failed (paper jam, offline…)
  assert.equal(isDuplicateRequest("r9", t + 100), false, "retry goes straight through");
  clearJobFailure("r9"); // retry succeeded
  assert.equal(isDuplicateRequest("r9", t + 150), true, "after success the window applies again");
});

test("density: long carts compact, tiny carts roomy, middle normal", () => {
  assert.equal(suggestDensity(50), "compact");
  assert.equal(suggestDensity(2), "roomy");
  assert.equal(suggestDensity(10), "normal");
});

test("length estimate grows with items; compact beats normal beats roomy", () => {
  const one = estimateReceiptLengthMm(1, "normal");
  const hundred = estimateReceiptLengthMm(100, "normal");
  assert.ok(hundred - one > 90 * 5, "each of the 99 extra items adds ≈5+ mm");
  assert.ok(
    estimateReceiptLengthMm(100, "compact") < estimateReceiptLengthMm(100, "normal") &&
      estimateReceiptLengthMm(100, "normal") < estimateReceiptLengthMm(100, "roomy")
  );
});

test("roll forecast: 100 receipts/day ≈ single-digit days on an 80 m roll", () => {
  const days = rollDaysRemaining(100, 5);
  assert.ok(days !== null && days > 0 && days < 30);
  assert.equal(rollDaysRemaining(0, 5), null, "no volume → no forecast");
});

test("analytics aggregates by kind and profile with top errors", () => {
  const now = Date.now();
  recordEvent({ profileId: "p-thermal", kind: "receipt", ok: true, at: now });
  recordEvent({ profileId: "p-thermal", kind: "receipt", ok: true, at: now });
  recordEvent({ profileId: "p-thermal", kind: "receipt", ok: false, at: now, errorCode: "OFFLINE" });
  recordEvent({ profileId: "p-sheet", kind: "report", ok: true, at: now });

  const a = analytics(60000);
  assert.equal(a.total, 4);
  assert.equal(a.ok, 3);
  assert.equal(a.failed, 1);
  assert.equal(a.byKind["receipt"]!.ok, 2);
  assert.equal(a.byKind["receipt"]!.failed, 1);
  assert.equal(a.byProfile["p-sheet"]!.ok, 1);
  assert.deepEqual(a.topErrors[0], { code: "OFFLINE", count: 1 });
});
