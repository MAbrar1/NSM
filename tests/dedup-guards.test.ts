/* ═══════════════════════════════════════════════════════════════
   DEDUP GUARDS — the one-home rules
   Pins the invariants the deduplication wave established:

   1. eslint.config.mjs declares `no-raw-cents-format`,
      `no-raw-slugify`, and `no-raw-datetime` as errors (each with
      its canonical-home exemption), so the duplicated formatting
      chains cannot quietly return.
   2. No source outside the canonical homes actually contains the
      raw patterns — the file-tree scan twin of the ui-consistency
      tests, so the guard holds even before eslint runs.
   3. The canonical helpers exist where everything now points.
   Run: npx tsx --test tests/dedup-guards.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

test("eslint declares the no-raw-* one-home rules as errors with canonical exemptions", () => {
  const cfg = readFileSync(join(ROOT, "eslint.config.mjs"), "utf8");
  assert.match(cfg, /"@local\/no-raw-cents-format": "error"/);
  assert.match(cfg, /"@local\/no-raw-slugify": "error"/);
  assert.match(cfg, /"@local\/no-raw-datetime": "error"/);
  // Each exemption reads: if (file.includes("<canonical home>")) return {};
  assert.ok(
    cfg.includes('file.includes("/src/lib/money/")'),
    "cents rule must exempt the canonical home"
  );
  assert.ok(
    cfg.includes('file.includes("/src/lib/utils.ts")'),
    "slugify rule must exempt the canonical home"
  );
  assert.ok(
    cfg.includes('file.includes("/src/components/layout/live-clock.tsx")'),
    "datetime rule must exempt the self-managed live clock"
  );
});

test("no source outside lib/money still contains (x / 100).toFixed(2)", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mjs)$/.test(name)) {
        const rel = p.replace(/\\/g, "/").slice(ROOT.length + 1);
        if (rel.startsWith("src/lib/money/")) continue;
        if (/\/ 100\)\.toFixed\(2\)/.test(readFileSync(p, "utf8"))) offenders.push(rel);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "scripts"));
  assert.deepEqual(offenders, []);
});

test("no source outside lib/utils still contains the raw slug regex chain", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mjs)$/.test(name)) {
        const rel = p.replace(/\\/g, "/").slice(ROOT.length + 1);
        if (rel === "src/lib/utils.ts") continue;
        if (/\[\^a-z0-9\]\+\/g/.test(readFileSync(p, "utf8"))) offenders.push(rel);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "scripts"));
  assert.deepEqual(offenders, []);
});

test("no source outside the deliberate homes still calls locale-less toLocale*", () => {
  const offenders: string[] = [];
  const exempt = new Set(["src/components/layout/live-clock.tsx"]);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mjs)$/.test(name)) {
        const rel = p.replace(/\\/g, "/").slice(ROOT.length + 1);
        if (exempt.has(rel)) continue;
        const text = readFileSync(p, "utf8");
        const matches =
          text.match(/\.toLocale(String|DateString|TimeString)\(\s*\)/g) ?? [];
        offenders.push(...matches.map(() => rel));
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "scripts"));
  assert.deepEqual(offenders, []);
});

test("the one-home helpers exist and are exported", () => {
  const money = readFileSync(join(ROOT, "src", "lib", "money", "money.ts"), "utf8");
  assert.match(money, /export function centsToMajorString/);
  const utils = readFileSync(join(ROOT, "src", "lib", "utils.ts"), "utf8");
  assert.match(utils, /export function slugify/);
  assert.match(utils, /export function formatDateTime/);
});

test("withApiHandler is the shared 500 path (raw 500s are the rare, deliberate few)", () => {
  const { readdirSync: rd, statSync: st } = { readdirSync, statSync };
  let wrapperFiles = 0;
  let rawStanzas = 0;
  const walk = (dir: string) => {
    for (const name of rd(dir)) {
      const p = join(dir, name);
      if (st(p).isDirectory()) walk(p);
      else if (name === "route.ts") {
        const text = readFileSync(p, "utf8");
        if (text.includes("withApiHandler")) wrapperFiles++;
        const matches = text.match(/console\.error\("\[[A-Z_]+\]", error\)/g) ?? [];
        rawStanzas += matches.length;
      }
    }
  };
  walk(join(ROOT, "src", "app", "api"));
  assert.ok(wrapperFiles >= 40, `expected 40+ wrapper files, found ${wrapperFiles}`);
  // The remaining hand-rolled catches are semantic (domain-error → 400
  // mapping inside catch); only a bare-500 count this low means every
  // non-semantic stanza is on the wrapper.
  const raw500 = countRaw500s(join(ROOT, "src", "app", "api"));
  assert.ok(raw500 <= 10, `expected ≤10 raw 500-returns, found ${raw500}`);
});

function countRaw500s(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += countRaw500s(p);
    else if (name === "route.ts") {
      n += (readFileSync(p, "utf8").match(/return apiError\("Internal server error", 500\)/g) ?? []).length;
    }
  }
  return n;
}
