#!/usr/bin/env node
/*
 * ═══════════════════════════════════════════════════════════════════
 * DEV-SERVER SMOKE CHECK
 *
 * Boots `next dev`, waits for it to become ready, then fails (exit 1)
 * if the dev-server log contains a compile / module-resolution error.
 *
 * Why this exists: a stale or half-written `.next` makes `next dev`
 * emit `Cannot find module './NNNN.js'` and `Invalid
 * clientReferenceManifest` while still listening on the port, so every
 * route 500s. `next build` cannot catch that state — it rebuilds from
 * scratch — so this gates the *dev* entry point specifically.
 *
 * It deliberately does NOT fail on HTTP status: the CI database is a
 * placeholder, so DB-backed routes may legitimately be unavailable.
 * Only readiness + the error signatures below fail the run.
 *
 * Env:
 *   SMOKE_PORT        preferred port (default 3100; Next may pick another)
 *   SMOKE_TIMEOUT_MS  readiness timeout (default 120000)
 * ═══════════════════════════════════════════════════════════════════
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

const PREFERRED_PORT = Number(process.env.SMOKE_PORT ?? 3100);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);

/* Error signatures that mean the dev server compiled something wrong or
   could not resolve a module. The `⨯` marker is Next's own error prefix —
   it is what a middleware/route compile failure prints (e.g.
   "⨯ ./src/middleware.ts ... Syntax Error"), and is not emitted on a
   healthy boot. This gate only requests DB-free routes, so a runtime `⨯`
   here still signals a real problem rather than the CI placeholder DB. */
const ERROR_PATTERNS = [
  /^\s*⨯/m,
  /Failed to compile/i,
  /Module not found/i,
  /Cannot find module/i,
  /SyntaxError\b/i,
  /Syntax Error/i,
  /Unexpected eof/i,
  /InvariantError/,
];

function resolveNextBin() {
  try {
    return require.resolve("next/dist/bin/next");
  } catch {
    const fallback = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not locate the Next.js CLI (is `next` installed?)");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let output = "";
let exited = false;
let exitCode = null;

const nextBin = resolveNextBin();
const child = spawn(process.execPath, [nextBin, "dev", "-p", String(PREFERRED_PORT)], {
  cwd: process.cwd(),
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (buf) => {
  output += buf.toString();
});
child.stderr.on("data", (buf) => {
  output += buf.toString();
});
child.on("exit", (code) => {
  exited = true;
  exitCode = code;
});

async function waitForReady() {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (exited) return { ready: false, reason: `dev server exited early (code ${exitCode})` };
    if (/Ready in/i.test(output)) return { ready: true };
    await sleep(500);
  }
  return { ready: false, reason: `dev server was not ready within ${TIMEOUT_MS}ms` };
}

function actualPort() {
  const match = output.match(/Local:\s+http:\/\/localhost:(\d+)/i);
  return match ? Number(match[1]) : PREFERRED_PORT;
}

async function probe(pathname) {
  const url = `http://localhost:${actualPort()}${pathname}`;
  try {
    const res = await fetch(url, { redirect: "manual" });
    return res.status;
  } catch (err) {
    return `unreachable (${err?.name ?? "Error"})`;
  }
}

async function shutdown() {
  if (exited) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (!exited && Date.now() < deadline) await sleep(100);
  if (!exited) child.kill("SIGKILL");
}

const readiness = await waitForReady();
const failures = [];

if (readiness.ready) {
  const port = actualPort();
  console.log(`✓ dev server ready on :${port}`);
  // Touch the middleware + a public auth route so they compile during the run.
  console.log(`  GET /                  -> ${await probe("/")}`);
  console.log(`  GET /api/auth/session  -> ${await probe("/api/auth/session")}`);
} else {
  failures.push(readiness.reason);
}

for (const pattern of ERROR_PATTERNS) {
  if (pattern.test(output)) failures.push(`log matched ${pattern}`);
}

await shutdown();

const tail = output.split(/\r?\n/).filter((line) => line.trim());
console.log("──── dev-server output (tail) ────");
console.log(tail.slice(-20).join("\n"));

if (failures.length > 0) {
  console.error("\n❌ dev-server smoke check FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\n✅ dev-server smoke check passed (ready, no compile/module errors)");
// Exit explicitly: a killed child's pipe handles can otherwise keep the
// parent's event loop (and the CI step) alive.
process.exit(0);
