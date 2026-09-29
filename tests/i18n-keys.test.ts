/* ═══════════════════════════════════════════════════════════════
   i18n KEY COVERAGE — regression guard
   `t()` falls back to returning the key itself when a translation is
   missing, so a typo or a forgotten locale entry ships as a raw,
   user-visible string ("scanner.scanning") instead of text. This test
   walks every source file, extracts the keys passed to `t()` and
   asserts each one resolves in BOTH locales.

   Run: npx tsx --test tests/i18n-keys.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import en from "@/i18n/locales/en.json";
import ur from "@/i18n/locales/ur.json";

type Dict = Record<string, unknown>;

/** Flatten a nested locale object into dotted leaf keys. */
function flatten(obj: Dict, prefix = "", out: Set<string> = new Set()): Set<string> {
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      flatten(value as Dict, dotted, out);
    } else {
      out.add(dotted);
    }
  }
  return out;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Matches a literal `t("some.key")` call. The leading character class is
 * deliberately narrow: it rejects method calls whose name merely ends in
 * `t(` — e.g. `searchParams.get("from")` — which are not translations.
 */
const T_CALL = /(?:^|[^\w.$])t\("([A-Za-z][A-Za-z0-9_.]*)"/g;

function usedKeys(): Set<string> {
  const root = path.resolve(process.cwd(), "src");
  const keys = new Set<string>();
  for (const file of sourceFiles(root)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(T_CALL)) {
      const key = match[1];
      if (key) keys.add(key);
    }
  }
  return keys;
}

const enKeys = flatten(en as Dict);
const urKeys = flatten(ur as Dict);

test("locale files carry at least one key (sanity)", () => {
  assert.ok(enKeys.size > 0, "en.json flattened to zero keys");
  assert.ok(urKeys.size > 0, "ur.json flattened to zero keys");
});

test("every t() key used in src/ exists in the English locale", () => {
  const missing = [...usedKeys()].filter((key) => !enKeys.has(key)).sort();
  assert.deepEqual(missing, [], `Keys missing from en.json:\n${missing.join("\n")}`);
});

test("every t() key used in src/ exists in the Urdu locale", () => {
  // Only assert keys that English actually defines — a key missing from
  // English is already reported by the test above, and reporting it twice
  // buries the real signal.
  const missing = [...usedKeys()]
    .filter((key) => enKeys.has(key) && !urKeys.has(key))
    .sort();
  assert.deepEqual(missing, [], `Keys missing from ur.json:\n${missing.join("\n")}`);
});
