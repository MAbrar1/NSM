/* Dashboard visual + functional QA (i18n templates, currency sync, dark mode,
   RTL, mobile). CDP over Node's built-in WebSocket — same harness as audit5.mjs.
   Usage: node audit-dashboard.mjs   (expects dev server on 127.0.0.1:3000) */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
// Use localhost (matches AUTH_URL) so NextAuth accepts the Origin header
// that the CSRF-protected settings PUT is required to send.
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

// ── CDP plumbing ──
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

async function clickText(text, rootSel = "body") {
  return evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)}) || document;
    const els = [...root.querySelectorAll("button, a, span, td, th, label")];
    const el = els.find(e => (e.innerText || "").trim() === ${JSON.stringify(text)});
    if (!el) return false; el.click(); return true;
  })()`);
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
      await clickText("Sign in");
      authed = await waitFor(`location.pathname.startsWith('/dashboard')`, 25000);
    }
    if (authed) return true;
  }
  return false;
}

// ── In-page API helpers ──
// The browser session is already authenticated (UI login), so API calls run
// inside the page: cookies + Origin are then supplied correctly, avoiding
// Node-side NextAuth origin/cookie juggling entirely.
async function pageFetch(path, opts = {}) {
  const r = await evalJs(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify(opts)});
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  })()`);
  return r && !r.err ? r : { status: 0, body: null };
}

/* ─────────────── PHASES ─────────────── */

async function phaseCurrencyEndpoint() {
  console.log("\n── PHASE: /api/settings/currency ──");
  const r = await pageFetch("/api/settings/currency");
  const d = r.body || {};
  check("currency endpoint answers for a signed-in session", r.status === 200 && /^[A-Z]{3}$/.test(d.currency || ""), `${r.status} ${d.currency}`);
  return d.currency || "USD";
}

async function phaseDashboardDesktop() {
  console.log("\n── PHASE: dashboard (desktop, light) ──");
  const ok = await nav("/dashboard");
  check("dashboard renders", !!ok);
  // Wait for real data (dev-mode first hit of /api/dashboard compiles on
  // demand — never assert against a fixed sleep after static text).
  const kpiReady = await waitFor(`document.body.innerText.toLowerCase().includes("today's revenue")`, 25000);
  check("KPI section renders with live data", !!kpiReady);
  const lower = (await text()).toLowerCase();
  check("no raw i18n keys leak into the UI", !(await text()).includes("dashboard.topCustomers") && !(await text()).includes("dashboard.orderStatusBreakdown"));
  check("Top Customers card title localizes", (await text()).includes("Top Customers"));
  check("Order Status Breakdown card title localizes", (await text()).includes("Order Status Breakdown"));
  // StatCard labels render with CSS text-transform: uppercase, so innerText
  // arrives as "TODAY'S REVENUE" — compare case-insensitively.
  check("outstanding-dues KPI localizes", lower.includes("outstanding dues"));
  check("manual refresh button present", await waitFor(`!!document.querySelector('button[aria-label="Refresh now"]')`, 5000));

  // Heatmap rows: 1 label + 24 hour cells (duplicate-label regression check)
  const rows = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('div.grid')].filter(r => (r.className || "").includes("grid-cols-[3.5rem_repeat(24"));
    return rows.map(r => r.children.length);
  })()`);
  if (rows.length === 0) {
    console.log("  (heatmap has no data rows — structure check skipped)");
  } else {
    check("each heatmap row = 1 label + 24 cells (no duplicated label)", rows.every((n) => n === 25), JSON.stringify(rows));
  }

  // Activity feed uses sentence templates, not bare verbs
  const activitySentence = await evalJs(`(() => {
    const feed = [...document.querySelectorAll('h3')].find(h => (h.innerText || "").includes("Live activity"));
    if (!feed) return null;
    const card = feed.closest("div.rounded-xl, div[class*=rounded]");
    return card ? card.innerText : null;
  })()`);
  if (activitySentence && activitySentence.split("\n").length > 2) {
    const bareVerb = /^(sold|refunded|adjusted|transferred|created|updated|deleted)$/m.test(activitySentence.split("\n").join("\n"));
    check("activity feed renders sentences (no bare verb lines)", !bareVerb);
  } else {
    console.log("  (activity feed empty — template check skipped)");
  }

  await shot("dashboard-light-desktop");
}

async function phaseCurrencyLive(original) {
  console.log("\n── PHASE: settings-aware currency ──");
  // Toggle to the OTHER currency so the change is observable, then restore.
  const target = original === "PKR" ? "USD" : "PKR";
  const put = await pageFetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currency: target }),
  });
  check(`settings PUT accepts a currency change (${target})`, put.status === 200);

  await nav("/dashboard");
  // USD renders as "$…" (no literal "USD"), PKR renders as "PKR …" — so the
  // observable signal of the switch is the disappearance of the old symbol.
  const oldMark = target === "USD" ? "PKR" : "$";
  const switched = await waitFor(`!document.body.innerText.includes(${JSON.stringify(oldMark)})`, 20000);
  check(`dashboard amounts re-format to the store currency (${target})`, !!switched);
  await shot("dashboard-currency-switch");

  // Restore
  const restore = await pageFetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currency: original }),
  });
  check("original currency restored", restore.status === 200, original);
}

async function phaseDarkMode() {
  console.log("\n── PHASE: dark mode + command palette ──");
  // Fresh full-load navigations in dev can 404 a lazy chunk mid-hydration
  // (leaving clicks dead) — so retry the whole flow with a fresh nav.
  let dark = false;
  for (let attempt = 0; attempt < 3 && !dark; attempt++) {
    await nav("/dashboard");
    await waitFor(`!!document.querySelector('button[title^="Theme:"]')`, 10000);
    await sleep(1000); // hydration settle
    for (let click = 0; click < 3 && !dark; click++) {
      await evalJs(`(() => {
        const b = document.querySelector('button[title^="Theme:"]');
        if (!b) return false; b.click(); return true;
      })()`);
      const picked = await waitFor(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => (x.innerText || "").trim().endsWith("Dark"));
        if (!b) return false; b.click(); return true;
      })()`, 2500);
      if (picked) dark = !!(await waitFor(`document.documentElement.classList.contains('dark')`, 5000));
    }
  }
  check("theme toggle switches to dark", dark);

  // Open the ⌘K command palette (retry with fresh nav — hydration timing in dev)
  let palette = false;
  for (let attempt = 0; attempt < 3 && !palette; attempt++) {
    if (attempt > 0) {
      await nav("/dashboard");
      await sleep(1000);
    }
    await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    palette = !!(await waitFor(`(() => {
      const f = [...document.querySelectorAll('form')].find(f => (f.innerText || "").includes("ESC"));
      return f ? true : false;
    })()`, 3000));
  }
  check("⌘K palette opens", !!palette);

  const bg = await evalJs(`(() => {
    const f = [...document.querySelectorAll('form')].find(f => (f.innerText || "").includes("ESC"));
    return f ? getComputedStyle(f).backgroundColor : null;
  })()`);
  check("palette surface is dark-aware (not white)", !!bg && bg !== "rgb(255, 255, 255)", bg);
  await shot("dashboard-dark-palette");

  // Close palette, restore light theme via the persisted preference
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await evalJs(`localStorage.setItem('elite-pos-theme', 'light'); location.reload(); true`);
  await waitFor(`!document.documentElement.classList.contains('dark')`, 12000);
}

async function phaseRTL() {
  console.log("\n── PHASE: Urdu RTL ──");
  await nav("/dashboard");
  await waitFor(`!!document.querySelector('header')`, 10000);
  await sleep(800); // hydration settle before clicking the toggle
  let switched = await clickText("اردو");
  let rtl = await waitFor(`document.documentElement.dir === 'rtl'`, 6000);
  if (!rtl) {
    switched = await clickText("اردو"); // one retry after full hydration
    rtl = await waitFor(`document.documentElement.dir === 'rtl'`, 6000);
  }
  check("language toggle switches to Urdu RTL", switched && !!rtl);
  await sleep(1000);
  await shot("dashboard-ur-rtl");
  const urduTitle = await evalJs(`(() => {
    const h1 = document.querySelector("h1");
    return h1 ? h1.innerText : "";
  })()`);
  check("h1 renders Urdu text", /[\u0600-\u06FF]/.test(urduTitle || ""), urduTitle);
  await clickText("EN");
  await waitFor(`document.documentElement.dir === 'ltr'`, 8000);
}

async function phaseMobile() {
  console.log("\n── PHASE: mobile 390×844 ──");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav("/dashboard");
  await waitFor(`document.body.innerText.includes("Today's Revenue") || document.body.innerText.includes("Quick Actions")`, 15000);
  await sleep(800);
  const overflow = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
  check("no horizontal page overflow on mobile", overflow <= 1, `overflow=${overflow}px`);
  await shot("dashboard-mobile");
  await send("Emulation.clearDeviceMetricsOverride");
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
    await sleep(800);
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
const apiAuthed = loggedIn; // API calls run in-page with the browser session
check("browser session ready for in-page API calls", !!apiAuthed);

let originalCurrency = "USD";
try {
  originalCurrency = await phaseCurrencyEndpoint();
  await phaseDashboardDesktop();
  await phaseCurrencyLive(originalCurrency);
  await phaseDarkMode();
  await phaseRTL();
  await phaseMobile();
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
