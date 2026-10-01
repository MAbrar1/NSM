/* ═══════════════════════════════════════════════════════════════
   ALERT FEED HELPERS — unit tests
   Locks the pure helpers the notification bell relies on:
   severity ordering, worst-severity, defensive parsing of the
   /api/alerts payload, unseen counting and localized messages. These
   are the pieces that must never let a failed/malformed scan render
   as an all-good ("all stocked") bell.
   Run: npx tsx --test tests/alert-feed.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertKindLabel,
  alertMessage,
  countUnseen,
  feedAlertIds,
  parseAlertFeed,
  severityRank,
  sortAlertsBySeverity,
  worstSeverity,
  EMPTY_ALERT_FEED,
  type StockAlert,
} from "@/lib/notifications/alert-utils";

function alert(over: Partial<StockAlert>): StockAlert {
  return {
    id: over.id ?? "p1:w1",
    severity: over.severity ?? "warning",
    kind: over.kind ?? "below_min",
    message: "",
    remaining: over.remaining ?? 2,
    minStock: over.minStock ?? 10,
    currentStock: over.currentStock ?? 2,
    productId: over.productId ?? "p1",
    productName: over.productName ?? "Cola",
    sku: over.sku ?? "BEV-1",
    category: over.category ?? "Drinks",
    warehouseId: over.warehouseId ?? "w1",
    warehouseName: over.warehouseName ?? "Main",
    stockValue: 0,
    unitPrice: 0,
    ...over,
  };
}

test("severity order is critical → warning → info", () => {
  assert.ok(severityRank("critical") < severityRank("warning"));
  assert.ok(severityRank("warning") < severityRank("info"));
});

test("sortAlertsBySeverity puts the worst first and never mutates the input", () => {
  const input = [
    alert({ id: "a", severity: "info" }),
    alert({ id: "b", severity: "critical" }),
    alert({ id: "c", severity: "warning" }),
  ];
  const sorted = sortAlertsBySeverity(input);
  assert.deepEqual(
    sorted.map((a) => a.id),
    ["b", "c", "a"]
  );
  assert.deepEqual(
    input.map((a) => a.id),
    ["a", "b", "c"],
    "input array was mutated"
  );
});

test("worstSeverity reports the most severe entry, or null when empty", () => {
  assert.equal(worstSeverity([]), null);
  assert.equal(
    worstSeverity([alert({ severity: "info" }), alert({ severity: "critical" })]),
    "critical"
  );
  assert.equal(worstSeverity([alert({ severity: "warning" })]), "warning");
});

test("parseAlertFeed degrades a malformed payload to an empty feed without throwing", () => {
  const feed = parseAlertFeed(null);
  assert.deepEqual(feed.alerts, []);
  assert.deepEqual(feed.restockSoon, []);
  assert.equal(feed.summary.total, 0);
  assert.equal(feed.restockSoonCount, 0);
  assert.equal(feed.inAppEnabled, true);

  const junk = parseAlertFeed({ alerts: "nope", summary: 42, inAppEnabled: false });
  assert.deepEqual(junk.alerts, []);
  assert.equal(junk.summary.critical, 0);
  assert.equal(junk.inAppEnabled, false);
});

test("parseAlertFeed derives summary counts when the server omits them", () => {
  const feed = parseAlertFeed({
    alerts: [alert({ id: "1", severity: "critical" }), alert({ id: "2", severity: "warning" })],
    restockSoon: [alert({ id: "3", severity: "info" })],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(feed.summary.total, 2);
  assert.equal(feed.summary.critical, 1);
  assert.equal(feed.summary.warning, 1);
  assert.equal(feed.restockSoonCount, 1);
  assert.equal(feed.generatedAt, "2026-01-01T00:00:00.000Z");
});

test("an explicit inAppEnabled:false is preserved (the setting can switch the bell off)", () => {
  assert.equal(parseAlertFeed({ inAppEnabled: false }).inAppEnabled, false);
  assert.equal(parseAlertFeed({ inAppEnabled: true }).inAppEnabled, true);
});

test("countUnseen counts new ids across BOTH channels and ignores seen ones", () => {
  const feed = {
    alerts: [alert({ id: "a" }), alert({ id: "b" })],
    restockSoon: [alert({ id: "c" })],
  };
  assert.equal(countUnseen(feed, new Set()), 3);
  assert.equal(countUnseen(feed, new Set(["a", "c"])), 1);
  assert.equal(countUnseen(feed, new Set(["a", "b", "c"])), 0);
  assert.deepEqual(feedAlertIds(feed), ["a", "b", "c"]);
});

test("EMPTY_ALERT_FEED is inert and in-app enabled", () => {
  assert.deepEqual(EMPTY_ALERT_FEED.alerts, []);
  assert.deepEqual(EMPTY_ALERT_FEED.restockSoon, []);
  assert.equal(EMPTY_ALERT_FEED.inAppEnabled, true);
});

test("alertMessage renders a localized line per kind", () => {
  const t = (key: string) =>
    ({
      "alerts.min": "min",
      "alerts.remaining": "remaining",
      "alerts.outOfStock": "Out of stock",
      "alerts.criticallyLow": "Critically low",
      "alerts.belowMin": "Below minimum",
      "alerts.runningLow": "Running low",
    })[key] ?? key;

  assert.equal(alertMessage(alert({ kind: "out_of_stock" }), t), "Out of stock");
  assert.match(
    alertMessage(alert({ kind: "critical", remaining: 3, minStock: 10 }), t),
    /Critically low/
  );
  assert.match(
    alertMessage(alert({ kind: "below_min", remaining: 8, minStock: 10 }), t),
    /Below minimum/
  );
  assert.match(alertMessage(alert({ kind: "running_low", remaining: 20 }), t), /Running low/);
});

test("alertKindLabel maps every kind to one shared label (and tolerates unknown)", () => {
  const t = (key: string) =>
    ({
      "alerts.outOfStock": "Out of stock",
      "alerts.criticallyLow": "Critically low",
      "alerts.belowMin": "Below minimum",
      "alerts.runningLow": "Running low",
      "dashboard.warning": "warning",
    })[key] ?? key;

  assert.equal(alertKindLabel("out_of_stock", t), "Out of stock");
  assert.equal(alertKindLabel("critical", t), "Critically low");
  assert.equal(alertKindLabel("below_min", t), "Below minimum");
  assert.equal(alertKindLabel("running_low", t), "Running low");
  assert.equal(alertKindLabel(null, t), "warning");
  assert.equal(alertKindLabel("something_else", t), "warning");
});
