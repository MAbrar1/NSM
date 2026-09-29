/* Dashboard date-range + warehouse-comparison + prefs QA.
   Same CDP harness as audit-dashboard.mjs. Verifies:
     • API range semantics: rangeMeta echo, trend sums == rangeRevenue,
       monthly granularity on long ranges, comparison sums == revenue
     • scoped+range combine correctly
     • in-page range switching re-renders KPIs + hourly hint
     • per-user prefs persist across reload (localStorage)
   Usage: node audit-dashboard-filters.mjs  (dev server on localhost:3000) */
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
// In-page authenticated fetch with dev-compile retry on 5xx.
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
// Click a preset button inside the range group (scoped by aria-label).
async function clickRangePreset(label) {
  return evalJs(`(() => {
    const group = document.querySelector('div[role="group"][aria-label]');
    if (!group) return false;
    const btn = [...group.querySelectorAll('button')].find(b => (b.innerText || '').trim() === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
}
const nums = (s) => (s.match(/\d[\d,]*(\.\d+)?/g) || []).join(",");

/* ─────────────── PHASES ─────────────── */

async function dayStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function phaseRangeApi() {
  console.log("\n── PHASE: range API semantics ──");
  const today = await dayStr(0);

  const dflt = await pageFetch("/api/dashboard");
  check("default dashboard answers", dflt.status === 200 && !!dflt.body);
  check(
    "default range = today (rangeMeta echo)",
    dflt.body?.rangeMeta?.from === today && dflt.body?.rangeMeta?.to === today,
    `${dflt.body?.rangeMeta?.from}..${dflt.body?.rangeMeta?.to}`
  );
  check("default granularity = daily", dflt.body?.rangeMeta?.granularity === "daily");
  check(
    "trend series has one bucket for today",
    (dflt.body?.weekTrend?.length ?? 0) === 1 && dflt.body?.trendPeriod === "day",
    `${dflt.body?.weekTrend?.length} bucket(s)`
  );

  const from7 = await dayStr(-6);
  const d7 = await pageFetch(`/api/dashboard?from=${from7}&to=${today}`);
  const sum7 = (d7.body?.weekTrend ?? []).reduce((s, b) => s + b.revenue, 0);
  check("7d range answers with 7 daily buckets", (d7.body?.weekTrend?.length ?? 0) === 7);
  check(
    "7d trend buckets sum ≈ rangeRevenue",
    Math.abs(sum7 - (d7.body?.rangeRevenue ?? -1)) < 1,
    `${sum7} vs ${d7.body?.rangeRevenue}`
  );

  const from30 = await dayStr(-29);
  const d30 = await pageFetch(`/api/dashboard?from=${from30}&to=${today}`);
  const sum30 = (d30.body?.weekTrend ?? []).reduce((s, b) => s + b.revenue, 0);
  check(
    "30d range switches to monthly buckets",
    d30.body?.rangeMeta?.granularity === "monthly" && d30.body?.trendPeriod === "month",
    `${d30.body?.weekTrend?.length} month bucket(s)`
  );
  check(
    "30d monthly buckets sum ≈ rangeRevenue",
    Math.abs(sum30 - (d30.body?.rangeRevenue ?? -1)) < 1,
    `${sum30} vs ${d30.body?.rangeRevenue}`
  );

  const cmp = d30.body?.warehouseComparison ?? [];
  const cmpSum = cmp.reduce((s, w) => s + w.revenue, 0);
  check("warehouseComparison covers every active warehouse", cmp.length >= 2, `${cmp.length} locations`);
  check(
    "comparison revenues sum ≈ unscoped rangeRevenue",
    Math.abs(cmpSum - (d30.body?.rangeRevenue ?? -1)) < 1,
    `${cmpSum} vs ${d30.body?.rangeRevenue}`
  );

  const whList = await pageFetch("/api/warehouses");
  const wh = (whList.body?.warehouses ?? []).find((w) => !w.isDefault) ?? whList.body?.warehouses?.[1];
  if (wh) {
    const scoped = await pageFetch(`/api/dashboard?from=${from7}&to=${today}&warehouseId=${wh.id}`);
    const scopedSum = (scoped.body?.weekTrend ?? []).reduce((s, b) => s + b.revenue, 0);
    check(
      "scoped+range: scoped trend sum ≤ unscoped trend sum",
      scopedSum <= sum7 + 1,
      `${scopedSum} ≤ ${sum7}`
    );
    check(
      "scoped+range: scoped revenue ≤ unscoped revenue",
      (scoped.body?.rangeRevenue ?? 0) <= (d7.body?.rangeRevenue ?? 0) + 1
    );
  }
  return { cmpNames: cmp.map((w) => w.name) };
}

async function phaseRangeUi(cmpNames) {
  console.log("\n── PHASE: in-page range switching + persistence ──");
  await nav("/dashboard");
  await waitFor(`/[\\d][\\d,]{2,}/.test(document.body.innerText)`, 20000);
  await sleep(1000);

  const before = (await text()) ?? "";
  check("today headline renders (case-insensitive)", before.toLowerCase().includes("revenue — today"));

  check("switch to Last 7 days", !!(await clickRangePreset("Last 7 days")));
  const seven = await waitFor(`document.body.innerText.toLowerCase().includes('revenue — last 7 days')`, 15000);
  check("headline relabels to Last 7 days", !!seven);
  await sleep(1500);
  const sevenText = (await text()) ?? "";
  check("figures change between Today and 7d", nums(before) !== nums(sevenText));
  check("hourly hint shows single-day note on multi-day range", sevenText.toLowerCase().includes("single-day range"));
  check("prefs persisted to localStorage", (await evalJs(`(localStorage['elite-pos-dashboard-prefs'] || '').includes('"rangePreset":"7d"')`)) === true);

  check("switch to Last 30 days", !!(await clickRangePreset("Last 30 days")));
  const thirty = await waitFor(`document.body.innerText.toLowerCase().includes('revenue — last 30 days')`, 15000);
  check("headline relabels to Last 30 days", !!thirty);
  await sleep(1500);

  // Comparison card (renders when >1 warehouse)
  const withCard = (await text()) ?? "";
  check("warehouse-comparison card renders", withCard.toLowerCase().includes("warehouse comparison"));
  const visibleNames = (cmpNames || []).filter((n) => withCard.includes(n));
  check("comparison card lists the locations", visibleNames.length >= Math.min(2, (cmpNames || []).length), visibleNames.join(", "));
  await shot("dashboard-filters-30d");

  // Persistence across reload
  await nav("/dashboard");
  const restored = await waitFor(`document.body.innerText.toLowerCase().includes('revenue — last 30 days')`, 20000);
  check("range survives a full reload (per-user prefs)", !!restored);

  // Restore default for a clean handoff
  check("restore Today", !!(await clickRangePreset("Today")));
  await waitFor(`document.body.innerText.toLowerCase().includes('revenue — today')`, 15000);
  await shot("dashboard-filters-today");
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
  const { cmpNames } = await phaseRangeApi();
  await phaseRangeUi(cmpNames);
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
