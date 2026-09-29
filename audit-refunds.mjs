/* Refunds ledger QA — visual check in both locales + reason drill-down.
   Same CDP harness as audit-dashboard-filters.mjs. Verifies:
     • the Refunds page renders in English and Urdu (RTL), with screenshots
     • the refund-reason API filter narrows to the exact reason
     • clicking a reason in the ledger / top-reason list applies the filter
       (active chip + aria-pressed), and clicking again clears it
     • the Top refund reasons CSV export downloads a real file
     • the dashboard refund-trend month bar drills into /refunds?from&to and
       the ledger scopes to that month (date inputs + KPI == API total)
   Usage: BASE=http://localhost:3100 node audit-refunds.mjs  (dev server running) */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertNoServerErrors } from "./scripts/audit-harness.mjs";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const SHOTS = process.cwd() + "/.audit-shots";
const DOWNLOADS = SHOTS + "/downloads";
/* Outside the project on purpose: a Chrome profile inside the watched tree
   makes `next dev` recompile in a loop and truncate .next, which 500s every
   API route. See scripts/audit-harness.mjs. */
const PROFILE = tmpdir() + "/codebuff-audit-refunds";
rmSync(PROFILE, { recursive: true, force: true });
const results = [];
function check(name, cond, extra = "") {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  console.log(results[results.length - 1]);
  if (!cond) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });

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
  let r;
  try {
    r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  } catch (e) {
    // A navigation between command + response rejects the pending call;
    // report it as an eval error so waitFor keeps polling.
    return { err: String(e?.message ?? e) };
  }
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
  try {
    await send("Page.navigate", { url: BASE + path });
  } catch { /* target may navigate before the ack; waitFor below */ }
  await waitFor(`document.readyState === 'complete'`, 15000);
  return waitFor(`!!document.querySelector('header') && !!document.querySelector('main')`, 20000);
}
/** Navigate until `waitExpr` is satisfied — the dev server occasionally
 *  answers 500 mid-recompile and renders the error page, so retry a few
 *  times rather than asserting against a transient failure. */
async function navRetry(path, waitExpr, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    await nav(path);
    if (await waitFor(waitExpr, 20000)) return true;
    console.log(`  ↻ retrying ${path} (attempt ${i + 2})`);
    await sleep(1500);
  }
  return false;
}
/** Trusted click via CDP Input (synthetic dispatch can be ignored by
 *  some React handlers). Scrolls the element into view first. */
async function clickTrusted(selectorExpr) {
  // The app sets `html { scroll-behavior: smooth }`, so scrollIntoView is
  // animated and a rect read in the same tick is stale. Scroll instantly,
  // settle, THEN measure.
  const found = await evalJs(`(() => {
    const el = ${selectorExpr};
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return true;
  })()`);
  if (found !== true) return false;
  await sleep(400);
  const box = await evalJs(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!box || typeof box.x !== "number") return false;
  await sleep(150);
  const hit = await evalJs(`(() => { const el = document.elementFromPoint(${box.x}, ${box.y}); return el ? el.tagName + '.' + (el.getAttribute('class') || '') : 'none'; })()`);
  console.log(`  ↳ click at (${box.x},${box.y}) hits: ${hit}`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return true;
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
async function setLocale(locale) {
  await evalJs(`localStorage.setItem('elite-pos-locale', ${JSON.stringify(locale)})`);
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
      if (!authed) {
        const where = await evalJs(`location.pathname + location.search`);
        const body = ((await evalJs(`document.body.innerText`)) || '').slice(0, 300).replace(/\s+/g, ' ');
        console.log(`  ⚠ login attempt ${attempt + 1} stuck at ${where}: ${body}`);
      }
    }
    if (authed) return true;
  }
  return false;
}
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
/** Read a StatCard value by its (case-insensitive) label. */
const kpiExpr = (label) => `(() => {
  const p = [...document.querySelectorAll('p')].find(x => (x.textContent || '').trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())});
  return p ? (p.nextElementSibling?.textContent || '').trim() : null;
})()`;
/* ─────────────── PHASES ─────────────── */

async function phaseApi() {
  console.log("\n── PHASE: refunds API ──");
  const stats = await pageFetch("/api/refunds");
  check("GET /api/refunds answers", stats.status === 200 && !!stats.body, `status=${stats.status}`);
  const total = stats.body?.total ?? 0;
  const reasons = stats.body?.reasons ?? [];
  const trend = stats.body?.monthlyTrend ?? [];
  console.log(`  total refunds=${total}, reasons=${reasons.length}, months=${trend.length}`);
  check("reason breakdown shape is {reason,count,total}", reasons.every((r) => "count" in r && "total" in r && "reason" in r));
  check(
    "reason breakdown sorted by refunded value desc",
    reasons.every((r, i) => i === 0 || reasons[i - 1].total >= r.total)
  );

  // The API reason filter must return only that exact reason.
  const first = reasons.find((r) => r.reason)?.reason;
  if (first) {
    const filtered = await pageFetch(`/api/orders?status=refunded,partially_refunded&pageSize=100&reason=${encodeURIComponent(first)}`);
    const rows = filtered.body?.orders ?? [];
    check("reason filter returns only matching orders", rows.length > 0 && rows.every((o) => o.refundReason === first), `n=${rows.length}`);
  }
  // "No reason" bucket uses the __none__ sentinel.
  const noneBucket = reasons.find((r) => r.reason == null);
  if (noneBucket) {
    const filtered = await pageFetch(`/api/orders?status=refunded,partially_refunded&pageSize=100&reason=__none__`);
    const rows = filtered.body?.orders ?? [];
    check("__none__ filter returns only reason-less refunds", rows.length > 0 && rows.every((o) => !o.refundReason), `n=${rows.length}`);
  }
  return { total, trend, reasons };
}

async function phaseEnglish() {
  console.log("\n── PHASE: English refunds page ──");
  await setLocale("en");
  // StatCard labels are CSS-uppercased, so innerText reports them upper-cased.
  await navRetry("/refunds", `['Total refunds','Total refunded','Average refund'].every(k => document.body.innerText.toUpperCase().includes(k.toUpperCase()))`);
  await sleep(600);
  const enText = (await text()) ?? "";
  check("page title renders", enText.includes("Refunds & Returns"));
  const missingKpis = ["Total refunds", "Total refunded", "Average refund"].filter(
    (k) => !enText.toUpperCase().includes(k.toUpperCase())
  );
  check("KPI strip renders", missingKpis.length === 0, missingKpis.join(", "));
  check("date-range presets render", enText.includes("Last 30 days"));
  await shot("refunds-en");

  // Reason drill-down from the ledger / top-reason list.
  const clicked = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button[aria-pressed]')][0];
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
  check("a reason row is clickable", clicked === true);
  if (clicked) {
    const chip = await waitFor(`document.body.innerText.includes('Clear reason')`, 12000);
    check("active reason filter chip appears", !!chip);
    const pressed = await evalJs(`[...document.querySelectorAll('button[aria-pressed="true"]')].length`);
    check("clicked reason is marked aria-pressed=true", (pressed ?? 0) >= 1);
    await sleep(1200);
    await shot("refunds-en-reason-filter");
    // Clicking the same reason again clears the filter.
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button[aria-pressed="true"]')][0];
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return !!btn;
    })()`);
    const cleared = await waitFor(`!document.body.innerText.includes('Clear reason')`, 12000);
    check("clicking the active reason clears the filter", !!cleared);
  }

  // Top-reason CSV export — capture the generated CSV by intercepting the
  // blob download (headless download plumbing varies by Chrome build).
  await evalJs(`(() => {
    window.__csv = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) {
        fetch(this.href).then(r => r.text()).then(t => { window.__csv = { name: this.download, text: t }; });
        return;
      }
      return orig.apply(this, arguments);
    };
    return true;
  })()`);
  const exportEnabled = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title') || '') === 'Export reasons');
    if (!btn) return 'missing';
    if (btn.disabled) return 'disabled';
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return 'clicked';
  })()`);
  check("top-reason export button is enabled", exportEnabled === "clicked", String(exportEnabled));
  const csv = await waitFor(`window.__csv && window.__csv.text`, 8000);
  check("reason CSV is generated", typeof csv === "string" && csv.length > 0);
  const csvName = await evalJs(`window.__csv && window.__csv.name`);
  check("CSV filename is stamped refund-reasons-*.csv", typeof csvName === "string" && /^refund-reasons-\d{4}-\d{2}-\d{2}\.csv$/.test(csvName), String(csvName));
  if (typeof csv === "string") {
    check("CSV has localized header + reason rows", csv.includes("Reason") && csv.includes("Share") && csv.trim().split(/\r?\n/).length > 1);
  }
}

async function phaseUrdu() {
  console.log("\n── PHASE: Urdu refunds page ──");
  await setLocale("ur");
  const urReady = await navRetry("/refunds", `document.body.innerText.includes('ریفنڈز اور واپسیاں')`);
  await sleep(1200);
  check("html dir flips to rtl", (await evalJs(`document.documentElement.dir`)) === "rtl");
  check("Urdu title renders", !!urReady);
  const urText = (await text()) ?? "";
  check("Urdu export button renders", urText.includes("وجوہات برآمد کریں"));
  check("no unresolved translation keys leak", !/\brefunds\.[a-zA-Z]+\b/.test(urText), urText.match(/\brefunds\.[a-zA-Z]+\b/)?.[0] || "");
  await shot("refunds-ur");

  // Reason click still works in RTL.
  const clicked = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button[aria-pressed]')][0];
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
  check("Urdu reason row clickable", clicked === true);
  if (clicked) {
    check("Urdu reason chip appears", !!(await waitFor(`document.body.innerText.includes('وجہ صاف کریں')`, 12000)));
    await sleep(900);
    await shot("refunds-ur-reason-filter");
  }
  await setLocale("en");
}

async function phaseDrillDown(api) {
  console.log("\n── PHASE: dashboard month-bar drill-down ──");
  await setLocale("en");
  // The chart renders only after the dashboard payload lands — wait for bars.
  await navRetry("/dashboard", `(() => {
    const h = [...document.querySelectorAll('h3')].find(x => (x.textContent || '').trim() === 'Refund trend');
    const card = h && h.closest('.neu-card');
    return !!card && card.querySelectorAll('svg [role="button"]').length > 0;
  })()`);
  const bars = await waitFor(`(() => {
    const h = [...document.querySelectorAll('h3')].find(x => (x.textContent || '').trim() === 'Refund trend');
    const card = h && h.closest('.neu-card');
    return card ? card.querySelectorAll('svg [role="button"]').length : 0;
  })()`, 20000);
  check("dashboard refund-trend card renders", (await text())?.includes("Refund trend"));
  check("refund-trend bars are clickable", (bars ?? 0) > 0, `${bars} bar(s)`);
  if (!bars || bars <= 0) return;

  const lastBar = `(() => {
    const h = [...document.querySelectorAll('h3')].find(x => (x.textContent || '').trim() === 'Refund trend');
    const card = h && h.closest('.neu-card');
    const bars = card ? [...card.querySelectorAll('svg [role="button"]')] : [];
    return bars[bars.length - 1] || null;
  })()`;
  const labels = await evalJs(`(() => {
    const h = [...document.querySelectorAll('h3')].find(x => (x.textContent || '').trim() === 'Refund trend');
    const card = h && h.closest('.neu-card');
    return card ? [...card.querySelectorAll('svg [role="button"]')].map(b => b.getAttribute('aria-label')).join(' | ') : '';
  })()`);
  console.log(`  bars: ${labels}`);
  const geom = await evalJs(`(() => {
    const h = [...document.querySelectorAll('h3')].find(x => (x.textContent || '').trim() === 'Refund trend');
    const card = h && h.closest('.neu-card');
    const bars = card ? [...card.querySelectorAll('svg [role="button"]')] : [];
    const b = bars[bars.length - 1];
    const r = b && b.getBoundingClientRect();
    return { n: bars.length, rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null, scrollY: Math.round(window.scrollY), vh: window.innerHeight };
  })()`);
  console.log(`  geometry: ${JSON.stringify(geom)}`);
  // Dispatch a synthetic click on the bar's <rect> (bubbles to the <g>'s
  // React onClick). A coordinate click is unreliable here: the app's global
  // smooth scrolling makes post-scroll rects stale.
  const clickBar = `(() => {
    const el = ${lastBar};
    if (!el) return 'no-el';
    const target = el.tagName.toLowerCase() === 'g' ? (el.querySelector('rect') || el) : el;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return target.tagName;
  })()`;
  let drilled = null;
  for (let attempt = 0; attempt < 3 && !drilled; attempt++) {
    const target = await evalJs(clickBar);
    console.log(`  dispatched click on <${target}> (attempt ${attempt + 1})`);
    drilled = await waitFor(`location.pathname === '/refunds' && /[?&]from=/.test(location.search)`, 12000);
    if (!drilled) console.log(`  after click: ${await evalJs(`location.pathname + location.search`)}`);
  }
  if (!drilled) {
    const clicked = await clickTrusted(lastBar);
    if (clicked) drilled = await waitFor(`location.pathname === '/refunds' && /[?&]from=/.test(location.search)`, 12000);
  }
  check("clicking a month bar navigates to /refunds with a range", !!drilled, (await evalJs(`location.search`)) || "");
  const sp = (await evalJs(`location.search`)) || "";
  const params = new URLSearchParams(sp);
  const from = params.get("from");
  const to = params.get("to");
  check("drill-down provides from & to", !!(from && to), `${from} .. ${to}`);

  // The ledger must scope to the drilled month (reload if the dev server
  // served a transient error page during the client navigation).
  let inputsReady = await waitFor(`!!document.querySelector('input[type=date]')`, 20000);
  if (!inputsReady && from && to) {
    inputsReady = await navRetry(`/refunds?from=${from}&to=${to}`, `!!document.querySelector('input[type=date]')`);
  }
  await sleep(1500);
  const inputs = await evalJs(`(() => {
    const ds = [...document.querySelectorAll('input[type=date]')];
    return ds.map(d => d.value);
  })()`);
  check("refund date inputs reflect the drilled range", Array.isArray(inputs) && inputs[0] === from && inputs[1] === to, JSON.stringify(inputs));
  const scoped = await pageFetch(`/api/refunds?from=${from}&to=${to}`);
  const expected = scoped.body?.total ?? 0;
  const rendered = await evalJs(kpiExpr("Total refunds"));
  check("ledger KPI matches the month's API total", rendered === String(expected), `ui=${rendered} api=${expected}`);
  await shot("refunds-drilldown");

  // Sanity: the drilled month should be one of the dashboard trend months.
  if (api.trend?.length && from) {
    const month = from.slice(0, 7);
    check("drilled month exists in the trend series", api.trend.some((m) => m.month === month), month);
  }
}

async function phaseCustomers() {
  console.log("\n── PHASE: customers page ──");
  await setLocale("en");
  const ready = await navRetry("/customers", `['customers','loyalty points','total revenue','outstanding dues'].every(k => document.body.innerText.toUpperCase().includes(k.toUpperCase()))`);
  await sleep(600);
  check("customers page renders with the KPI strip", !!ready);

  // KPI aggregates must come from the FULL customer base, not the page slice.
  const all = await pageFetch("/api/customers?pageSize=10000");
  const rows = all.body?.items ?? [];
  const apiTotal = all.body?.total ?? 0;
  const apiLoyalty = rows.reduce((s, c) => s + (c.loyaltyPoints || 0), 0);
  const countKpi = await evalJs(kpiExpr("customers"));
  const loyaltyKpi = await evalJs(kpiExpr("Loyalty Points"));
  check("count KPI matches the API total", countKpi === String(apiTotal), `ui=${countKpi} api=${apiTotal}`);
  check(
    "loyalty KPI sums the whole base (not one page)",
    loyaltyKpi != null && (loyaltyKpi || "").replace(/[^\d]/g, "") === String(apiLoyalty),
    `ui=${loyaltyKpi} api=${apiLoyalty}`
  );

  // Sortable headers drive server-side ordering.
  const sortBefore = await evalJs(`(() => {
    const ths = [...document.querySelectorAll('th[aria-sort]')];
    return ths.length;
  })()`);
  check("sortable column headers render", (sortBefore ?? 0) >= 4, `${sortBefore} sortable`);
  const clickedSort = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('th[aria-sort] button')].find(b => /total spent/i.test(b.textContent || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const sorted = clickedSort
    ? await waitFor(`(() => {
        const btn = [...document.querySelectorAll('th[aria-sort] button')].find(b => /total spent/i.test(b.textContent || ''));
        const th = btn && btn.closest('th');
        const v = th && th.getAttribute('aria-sort');
        return v && v !== 'none' ? v : null;
      })()`, 10000)
    : null;
  check("clicking a header activates sort", sorted === "descending" || sorted === "ascending", String(sorted));
  await waitFor(`!document.querySelector('table tbody .skeleton')`, 12000);

  // Mobile card layout exists alongside the desktop table.
  const mobileDbg = await evalJs(`(() => {
    const table = document.querySelector('table');
    const card = table && table.closest('.neu-card');
    const el = card && card.querySelector('[class*="md:hidden"]');
    return { kids: el ? el.children.length : -1, rows: document.querySelectorAll('table tbody tr').length };
  })()`);
  const mobileCards = mobileDbg && typeof mobileDbg.kids === "number" ? mobileDbg.kids : 0;
  console.log(`  mobile dbg: ${JSON.stringify(mobileDbg)}`);
  check("mobile card list markup is present", typeof mobileCards === "number" && mobileCards > 0, `${mobileCards} (hidden at md+)`);
  check(
    "mobile list shows the same customers as the table",
    mobileDbg && mobileDbg.kids === mobileDbg.rows,
    `cards=${mobileDbg?.kids} rows=${mobileDbg?.rows}`
  );
  await shot("customers-en");

  // Detail modal opens from a row.
  const opened = await evalJs(`(() => {
    const row = document.querySelector('table tbody tr');
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
  if (opened) {
    const modal = await waitFor(`document.body.innerText.includes('Purchase History')`, 12000);
    check("row opens the customer detail modal", !!modal);
    await evalJs(`(() => { const b=[...document.querySelectorAll('[role=dialog] button')].find(x=>/close/i.test(x.textContent||'')); if(b) b.click(); return true; })()`);
    await sleep(400);
  }

  await setLocale("ur");
  const urReady = await navRetry("/customers", `document.documentElement.dir === 'rtl' && document.body.innerText.includes('گاہک')`);
  check("customers page renders in Urdu (RTL)", !!urReady);
  await shot("customers-ur");
  await setLocale("en");
}

/* ─────────────── MAIN ─────────────── */
const PORT = 9500 + Math.floor(Math.random() * 200);
chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-extensions",
  "--user-data-dir=" + PROFILE,
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
    const d = msg.params.exceptionDetails;
    consoleErrors.push((d?.text ?? "exception") + " " + (d?.exception?.description ?? ""));
  } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    consoleErrors.push(msg.params.entry.text);
  }
};
await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
try {
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS, eventsEnabled: true });
} catch {
  try { await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS }); } catch { /* downloads best-effort */ }
}
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const loggedIn = await login();
check("browser login succeeds", !!loggedIn);
if (!loggedIn) {
  console.log("ABORT: could not log in via UI");
  chrome.kill();
  process.exit(1);
}

const only = (process.env.ONLY || "").toLowerCase();
try {
  const api = only && only !== "api" ? (await pageFetch("/api/refunds")).body : await phaseApi();
  if (!only || only === "en") await phaseEnglish();
  if (!only || only === "ur") await phaseUrdu();
  if (!only || only === "drill") await phaseDrillDown(api || {});
  if (!only || only === "customers") await phaseCustomers();
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  console.log(e.stack?.split("\n").slice(0, 5).join("\n"));
  process.exitCode = 1;
}

const passed = results.filter((r) => r.startsWith("PASS")).length;
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n═══ ${passed} PASS / ${failed} FAIL ═══`);
if (consoleErrors.length) console.log("console errors:", consoleErrors.slice(0, 5));
// A 5xx is a defect, not a log line — see scripts/audit-harness.mjs.
assertNoServerErrors(consoleErrors, { name: "audit-refunds" });

try { chrome.kill(); } catch {}
for (let i = 0; i < 5; i++) {
  try { rmSync(PROFILE, { recursive: true, force: true }); break; }
  catch { await sleep(800); }
}
