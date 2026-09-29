/* ═══════════════════════════════════════════════════════════════
   UI CONSISTENCY — regression guard
   Four empty/loading vocabularies had drifted apart across the app
   (a bespoke `.empty-state` recipe, bare-text table empties, and a
   network failure that rendered as an empty dataset). They now all
   funnel through `<EmptyState>` + `<TableSkeleton>`, and every list
   page distinguishes "no rows" from "couldn't load".

   This test pins that vocabulary by scanning the source, so a future
   page cannot quietly reintroduce a fifth shape.

   Run: npx tsx --test tests/ui-consistency.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Dashboard pages that render a data table and therefore own all three
 *  states: loading (skeleton), empty, and error. */
const LIST_PAGES = [
  "src/app/(dashboard)/orders/page.tsx",
  "src/app/(dashboard)/products/page.tsx",
  "src/app/(dashboard)/customers/page.tsx",
  "src/app/(dashboard)/refunds/page.tsx",
  "src/app/(dashboard)/inventory/page.tsx",
  "src/app/(dashboard)/users/page.tsx",
  "src/app/(dashboard)/suppliers/page.tsx",
  "src/app/(dashboard)/purchase-orders/page.tsx",
];

test("no source file references the legacy .empty-state recipe", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    // Matches a className/id that USES the class, not prose that names it.
    if (/\bclassName=\{?["'`][^"'`]*\bempty-state\b/.test(text)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `Legacy .empty-state used in:\n${offenders.join("\n")}`);
});

for (const rel of LIST_PAGES) {
  test(`${rel} uses the shared EmptyState + TableSkeleton vocabulary`, () => {
    const text = read(rel);
    assert.match(text, /from "@\/components\/ui\/empty-state"/, "missing EmptyState import");
    assert.match(text, /from "@\/components\/ui\/table-skeleton"/, "missing TableSkeleton import");
    assert.match(text, /<EmptyState\b/, "EmptyState is imported but never rendered");
    assert.match(text, /<TableSkeleton\b/, "TableSkeleton is imported but never rendered");
  });

  test(`${rel} distinguishes a load failure from an empty dataset`, () => {
    const text = read(rel);
    assert.match(text, /loadError/, "no loadError state — a failed fetch would render as empty");
    assert.match(
      text,
      /t\("common\.loadFailed"\)/,
      "no shared common.loadFailed copy on the error branch"
    );
  });
}

test("every list page offers a retry on its load failure", () => {
  for (const rel of LIST_PAGES) {
    assert.match(read(rel), /t\("common\.retry"\)/, `${rel} has no retry action on its error state`);
  }
});

/** Report pages fetch too, so they owe the same empty/error contract. */
const REPORT_PAGES = [
  "src/app/(dashboard)/reports/sales/page.tsx",
  "src/app/(dashboard)/reports/profit-loss/page.tsx",
  "src/app/(dashboard)/reports/inventory/page.tsx",
];

for (const rel of REPORT_PAGES) {
  test(`${rel} surfaces a retryable load failure`, () => {
    const text = read(rel);
    assert.match(text, /from "@\/components\/ui\/empty-state"/, "missing EmptyState import");
    assert.match(text, /<EmptyState\b/, "EmptyState is imported but never rendered");
    assert.match(text, /loadError/, "no loadError state — a failed fetch would render as blank");
    assert.match(text, /t\("reports\.loadFailed"\)/, "no shared reports.loadFailed copy");
    assert.match(text, /t\("common\.retry"\)/, "no retry action on the error state");
  });
}

test("POS renders its empty states through the shared EmptyState", () => {
  const text = read("src/app/(dashboard)/pos/page.tsx");
  assert.match(text, /from "@\/components\/ui\/empty-state"/, "missing EmptyState import");
  assert.match(text, /<EmptyState\b/, "POS has no shared empty state");
  assert.match(text, /skeleton h-|skeleton w-/, "no skeleton loading shape");
});

test("POS distinguishes browse/search load failures from empty results", () => {
  const text = read("src/app/(dashboard)/pos/page.tsx");
  assert.match(text, /browseError/, "browse fetch failure would render as 'no products'");
  assert.match(text, /searchError/, "search fetch failure would render as 'no results'");
  assert.match(text, /t\("common\.retry"\)/, "no retry on the POS error states");
});

test("POS payment failure surfaces an error and always clears the busy flag", () => {
  const text = read("src/app/(dashboard)/pos/page.tsx");
  assert.match(text, /async function processPayment/, "missing processPayment");
  assert.match(text, /toast\.error\(t\("pos\.paymentFailed"\)/, "no checkout failure toast");
  assert.match(text, /finally \{\s*setProcessing\(false\);/, "processing flag not reset in finally");
});

test("animate-spin lives only in the shared Spinner", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    if (file.endsWith(path.join("ui", "spinner.tsx"))) continue;
    if (/animate-spin/.test(fs.readFileSync(file, "utf8"))) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Hand-rolled spinners outside the shared Spinner:\n${offenders.join("\n")}`
  );
});

/** Forms that post to a server-validated endpoint, so a rejection can name a
 *  field. They must parse the field-keyed error and hand it to the input
 *  (instead of flattening it into one opaque toast). */
const FIELD_ERROR_FORMS = [
  "src/app/(dashboard)/users/page.tsx",
  "src/app/(dashboard)/suppliers/page.tsx",
  "src/app/(dashboard)/settings/page.tsx",
  "src/app/(dashboard)/settings/receipts/page.tsx",
];

for (const rel of FIELD_ERROR_FORMS) {
  test(`${rel} maps API field errors onto its inputs`, () => {
    const text = read(rel);
    assert.match(text, /fieldErrors/, "no fieldErrors state — a rejection cannot name a field");
    assert.match(text, /parseApiError|readApiError/, "does not parse field-keyed errors");
    assert.match(text, /error=\{fieldErrors\[/, "fieldErrors is never attached to an input");
  });
}

test("the purchase-order dialog maps API field errors onto its selects/lines", () => {
  const text = read("src/app/(dashboard)/purchase-orders/page.tsx");
  assert.match(text, /fieldErrors/, "no fieldErrors state — a rejection cannot name a field");
  assert.match(text, /readApiError/, "does not parse field-keyed errors");
  // The supplier/warehouse fields are <select>s, so they cannot use <Input error>;
  // they own their own red ring + message, exactly like the users role select.
  assert.match(text, /fieldErrors\["supplierId"\]/, "supplier field error is never rendered");
  assert.match(text, /fieldErrors\["warehouseId"\]/, "warehouse field error is never rendered");
  assert.match(text, /fieldErrors\["items"\]/, "items field error is never rendered");
});

test("the register form routes server errors onto its react-hook-form fields", () => {
  const text = read("src/app/register/page.tsx");
  assert.match(text, /readApiError/, "does not parse field-keyed errors");
  assert.match(text, /setError\(key, \{ type: "server"/, "server field errors are not mapped to fields");
});

const SETTINGS_PAGES = [
  "src/app/(dashboard)/settings/page.tsx",
  "src/app/(dashboard)/settings/audit-log/page.tsx",
  "src/app/(dashboard)/settings/receipts/page.tsx",
];

for (const rel of SETTINGS_PAGES) {
  test(`${rel} surfaces a retryable load failure`, () => {
    const text = read(rel);
    assert.match(text, /from "@\/components\/ui\/empty-state"/, "missing EmptyState import");
    assert.match(text, /loadError/, "no loadError state");
    assert.match(text, /t\("common\.retry"\)/, "no retry action on the error state");
  });
}

test("the login form tells account lockout, device throttle and server errors apart", () => {
  const text = read("src/app/login/page.tsx");
  // Each failure mode must land on its own message — a single generic
  // "invalid credentials" for all of them misleads the person signing in.
  assert.match(text, /result\.code === "rate_limited"/, "account-lockout code is not handled");
  assert.match(text, /result\.code === "rate_limited_ip"/, "device/IP throttle code is not handled");
  assert.match(text, /t\("auth\.tooManyAttemptsDevice"\)/, "device throttle has no distinct message");
  assert.match(
    text,
    /result\.error === "Configuration"/,
    "server misconfiguration is not told apart from bad credentials"
  );
  assert.match(text, /t\("auth\.serverError"\)/, "server misconfiguration has no distinct message");
});


