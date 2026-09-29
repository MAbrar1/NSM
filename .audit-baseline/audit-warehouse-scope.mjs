/* Per-warehouse scope QA for the dashboard.
   Reuses the audit-dashboard.mjs CDP harness pattern (headless Chrome +
   in-page authenticated fetch). Verifies:
     • /api/dashboard?warehouseId= scopes consistently (scoped ≤ all)
     • unknown warehouseId falls back to all-warehouse data
     • /api/alerts?warehouseId= returns only that warehouse's alerts
     • the dashboard scope selector renders, switches, and re-queries
   Usage: node audit-warehouse-scope.mjs  (dev server on localhost:3000) */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
const SHOTS = process.cwd() + "/.audit-shots";
const results = [];
function check(name, cond, extra = "") {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  console.log(results[results.length - 1]);
  if (!cond) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

// ── CDP plumbing (same as audit-dashboard.mjs) ──
let chrome = null;
let ws = null;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return { err: r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? "") };
  }
  return r.result?.value;
}

async function waitFor(expr, timeout = 12000, interval = 250) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await evalJs(expr);
    if (v && !v.err) return v;
    await sleep(interval);
  }
  const v = await evalJs(expr);
  return v && !v.err ? v : null;
}

async function nav(path) {
  await send("Page.navigate", { url: BASE + path });
  await waitFor(`document.readyState === 'complete'`, 15000);
  return waitFor(`!!document.querySelector('header') && !!document.querySelector('main')`, 20000);
}

async function text() {
  return evalJs(`document.body.innerText`);
}

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r?.data) {
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log(`  📸 ${SHOTS}/${name}.png`);
  }
}

async function login() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await nav("/dashboard");
    let authed = await waitFor(`location.pathname.startsWith('/dashboard') && !!document.querySelector('main')`, 20000);
    if (!authed) {
      await nav("/login");
      const ready = await waitFor(`!!document.querySelector('input[type=email]') && !!document.querySelector('input[type=password]')`, 20000);
      if (!ready) continue;
      await evalJs(`(() => { const e = document.querySelector('input[type=email]'); e.focus(); e.value = ''; })()`);
      await send("Input.insertText", { text: "admin@elitepos.com" });
      await evalJs(`(() => { const p = document.querySelector('input[type=password]'); p.focus(); p.value = ''; })()`);
      await send("Input.insertText", { text: "Admin@123" });
      await evalJs(`(() => {
        const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().toLowerCase().includes('sign in'));
        if (btn) btn.click();
        return !!btn;
      })()`);
      authed = await waitFor(`location.pathname.startsWith('/dashboard')`, 25000);
    }
    if (authed) return true;
  }
  return false;
}

// API calls run inside the page: cookies + Origin supplied by the browser.
// Retries 5xx/transport failures — in `next dev` the very first hit on a
// route triggers an on-demand compile that can 500; prod never does this.
async function pageFetch(path, opts = {}) {
  let r = { status: 0, body: null };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await evalJs(`(async () => {
      const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify(opts)});
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    })()`);
    r = res && !res.err ? res : { status: 0, body: null };
    if (r.status > 0 && r.status < 500) return r;
    await sleep(1200);
  }
  return r;
}

/* ─────────────── PHASES ─────────────── */

async function phaseScopedApi() {
  console.log("\n── PHASE: scoped API consistency ──");
  const all = await pageFetch("/api/dashboard");
  check("unscoped dashboard answers", all.status === 200 && all.body && typeof all.body.rangeRevenue === "number", `status=${all.status}`);

  const whList = await pageFetch("/api/warehouses");
  const whs = whList?.body?.warehouses ?? [];
  check("warehouse list answers", whList.status === 200 && whs.length >= 1, `${whs.length} warehouses`);
  if (whs.length < 2) {
    console.log("SKIP: need ≥2 warehouses for scope assertions");
    return null;
  }
  // Prefer a non-default warehouse — the seeder routes ~55% of orders to the default.
  const wh = whs.find((w) => !w.isDefault) ?? whs[1];

  const scoped = await pageFetch(`/api/dashboard?warehouseId=${wh.id}`);
  check("scoped dashboard answers", scoped.status === 200 && scoped.body && typeof scoped.body.rangeRevenue === "number", `status=${scoped.status}`);

  check(
    "scoped rangeRevenue ≤ all-warehouse total",
    scoped.body.rangeRevenue <= all.body.rangeRevenue + 0.009,
    `${scoped.body.rangeRevenue} ≤ ${all.body.rangeRevenue}`
  );
  check(
    "scoped monthRevenue ≤ all-warehouse total",
    scoped.body.monthRevenue <= all.body.monthRevenue + 0.009,
    `${scoped.body.monthRevenue} ≤ ${all.body.monthRevenue}`
  );
  check(
    "scoped weekTrend orders ≤ all-warehouse trend orders",
    scoped.body.weekTrend.reduce((s, d) => s + d.orders, 0) <= all.body.weekTrend.reduce((s, d) => s + d.orders, 0),
    `${scoped.body.weekTrend.reduce((s, d) => s + d.orders, 0)} ≤ ${all.body.weekTrend.reduce((s, d) => s + d.orders, 0)}`
  );

  // Unknown id must silently mean "all" (documented fallback).
  const bogus = await pageFetch("/api/dashboard?warehouseId=does-not-exist");
  check(
    "unknown warehouseId falls back to all data",
    bogus.status === 200 && Math.abs((bogus.body?.rangeRevenue ?? -1) - all.body.rangeRevenue) < 0.009
  );

  // Alerts scoping.
  const allA = await pageFetch("/api/alerts");
  const scA = await pageFetch(`/api/alerts?warehouseId=${wh.id}`);
  const allBelong = scA.status === 200 && (scA.body.alerts ?? []).every((a) => a.warehouseId === wh.id);
  check("scoped alerts all belong to the chosen warehouse", allBelong, `${(scA.body.alerts ?? []).length} alerts`);
  check(
    "scoped alert summary ≤ unscoped summary",
    (scA.body.summary?.total ?? 0) <= (allA.body.summary?.total ?? 0),
    `${scA.body.summary?.total} ≤ ${allA.body.summary?.total}`
  );
  return wh;
}

async function phaseScopeSwitch(wh) {
  console.log("\n── PHASE: in-page scope switch ──");
  await nav("/dashboard");
  const selReady = await waitFor(`!!document.querySelector('#dashboard-scope')`, 25000);
  check("scope selector renders with multiple warehouses", !!selReady);
  if (!selReady) return;

  // Wait for KPI data to land (currency amounts appear), then snapshot.
  await waitFor(`/[\\d][\\d,]{2,}/.test(document.body.innerText)`, 15000);
  await sleep(600);
  const beforeText = (await text()) ?? "";
  const nums = (s) => (s.match(/\d[\d,]*(\.\d+)?/g) || []).join(",");

  // React-controlled <select>: use the native value setter + change event.
  const switched = await evalJs(`(() => {
    const s = document.querySelector('#dashboard-scope');
    if (!s) return false;
    if (![...s.options].some(o => o.value === ${JSON.stringify(wh.id)})) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, ${JSON.stringify(wh.id)});
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  check("scope switch dispatched to the scoped warehouse", !!switched);

  const reflected = await waitFor(`document.querySelector('#dashboard-scope')?.value === ${JSON.stringify(wh.id)}`, 5000);
  check("selector state reflects the scoped warehouse", !!reflected);

  await sleep(3000); // refetch + render settle
  const afterText = (await text()) ?? "";
  check("dashboard figures change after scoping", nums(beforeText) !== nums(afterText));

  // Restore "All warehouses" for a clean state.
  await evalJs(`(() => {
    const s = document.querySelector('#dashboard-scope');
    if (!s) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, '');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1500);
  const restored = await evalJs(`document.querySelector('#dashboard-scope')?.value === ''`);
  check("scope restored to all warehouses", !!restored);
  await shot("dashboard-warehouse-scope");
}

/* ─────────────── MAIN ─────────────── */
const PORT = 9333 + Math.floor(Math.random() * 200);

chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-extensions",
  "--user-data-dir=" + process.cwd() + "/.audit-chrome-profile",
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });

await sleep(2500);
let tab = null;
for (let i = 0; i < 15; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    tab = await res.json();
    break;
  } catch {
    await sleep(1000);
  }
}
if (!tab?.webSocketDebuggerUrl) {
  console.log("FAIL: could not open CDP tab");
  process.exit(1);
}
ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(msg.params.exceptionDetails?.text ?? "exception");
  } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    consoleErrors.push(msg.params.entry.text);
  }
};
await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const loggedIn = await login();
check("browser login succeeds", !!loggedIn);
if (!loggedIn) {
  console.log("ABORT: could not log in via UI");
  chrome.kill();
  process.exit(1);
}

try {
  const wh = await phaseScopedApi();
  if (wh) await phaseScopeSwitch(wh);
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
}

const passed = results.filter((r) => r.startsWith("PASS")).length;
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n═══ ${passed} PASS / ${failed} FAIL ═══`);
if (consoleErrors.length) console.log("console errors:", consoleErrors.slice(0, 5));

try { chrome.kill(); } catch {}
for (let i = 0; i < 5; i++) {
  try { rmSync(process.cwd() + "/.audit-chrome-profile", { recursive: true, force: true }); break; }
  catch { await sleep(800); }
}
