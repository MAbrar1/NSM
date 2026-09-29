#!/usr/bin/env node
/*
 * ═══════════════════════════════════════════════════════════════════
 * BROWSER GATES — boot the built app, then run the two real-browser
 * checks that a compile-only CI cannot prove:
 *
 *   • audit-neu-pages.mjs — the migrated PAGE markup resolves to the neu
 *     tokens under :hover / :focus / :disabled / group / peer variants.
 *   • scripts/verify-ui.mjs — the empty/error/validation vocabulary end
 *     to end, including live API field-key probes (11 checks).
 *
 * Both need a running server AND a seeded database. CI seeds a throwaway
 * SQLite file first (see .github/workflows/ci.yml); locally this reuses
 * whatever DATABASE_URL / .env already points at.
 *
 * `next build` must have run — the checks start the production server.
 *
 * Env:
 *   BASE_URL                  default http://localhost:3311
 *   BROWSER_PORT              default 3311
 *   BROWSER_READY_TIMEOUT_MS  default 120000
 *   CHROME_PATH               forwarded to the child scripts
 * ═══════════════════════════════════════════════════════════════════
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

const PORT = Number(process.env.BROWSER_PORT ?? 3311);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const READY_TIMEOUT_MS = Number(process.env.BROWSER_READY_TIMEOUT_MS ?? 120_000);
const NEXT_TELEMETRY_DISABLED = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("✖ No production build found (.next/BUILD_ID). Run `npm run build` first.");
  process.exit(1);
}

let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next");
} catch {
  const fallback = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(fallback)) {
    console.error("✖ Could not locate the Next.js CLI (is `next` installed?).");
    process.exit(1);
  }
  nextBin = fallback;
}

let output = "";
let exited = false;
let exitCode = null;

const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (b) => (output += b.toString()));
server.stderr.on("data", (b) => (output += b.toString()));
server.on("exit", (code) => {
  exited = true;
  exitCode = code;
});

async function waitForReady() {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (exited) return { ready: false, reason: `server exited early (code ${exitCode})` };
    try {
      const res = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
      if (res.status < 500) return { ready: true };
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return { ready: false, reason: `server was not ready within ${READY_TIMEOUT_MS}ms` };
}

function runGate(label, argv) {
  console.log(`\n──────── ${label} ────────`);
  const res = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    env: { ...process.env, BASE_URL, NEXT_TELEMETRY_DISABLED, CI: process.env.CI ?? "" },
    stdio: "inherit",
  });
  const ok = res.status === 0;
  console.log(`${ok ? "✅" : "❌"} ${label} ${ok ? "passed" : `FAILED (exit ${res.status})`}`);
  return ok;
}

async function shutdown() {
  if (exited) return;
  server.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (!exited && Date.now() < deadline) await sleep(100);
  if (!exited) server.kill("SIGKILL");
}

const readiness = await waitForReady();
if (!readiness.ready) {
  console.error(`\n✖ Browser gates could not run: ${readiness.reason}`);
  console.error("──── server output (tail) ────");
  console.error(output.split(/\r?\n/).filter(Boolean).slice(-20).join("\n"));
  await shutdown();
  process.exit(1);
}
console.log(`✓ production server ready at ${BASE_URL}`);

const results = [
  ["Page design-system audit", ["audit-neu-pages.mjs"]],
  ["UI verification", ["scripts/verify-ui.mjs"]],
].map(([label, argv]) => runGate(label, argv));

await shutdown();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "ALL BROWSER GATES PASSED" : `${failed} BROWSER GATE(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
