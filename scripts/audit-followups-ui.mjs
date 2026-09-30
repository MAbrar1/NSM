/**
 * Browser verification for the follow-up fixes.
 *
 * Confirms, in a real logged-in session:
 *   1. /dashboard — the "Needs Restock" card is present, its headline number is
 *      a DISTINCT-product count (<= Total Products), its tooltip shows the
 *      "N out of stock · N low stock" split, and the sub-caption is the
 *      location-level alert count.
 *   2. /inventory — the KPI cards (Products Tracked / Low Stock / Out of Stock)
 *      come from the server summary, and the stock table + "N results" counter
 *      list EVERY row (not just the first page of 50). Also asserts the API
 *      itself: `/api/inventory?all=true` returns every row while the default
 *      page is capped at 50 when the catalog is larger.
 *   3. /settings — the "Early restock warnings" switch renders.
 *
 * Read-only: it never creates or mutates data. The Chrome profile lives in the
 * OS temp dir on purpose — a profile inside the watched tree makes `next dev`
 * recompile in a loop and truncate .next (see next.config.ts watchOptions).
 *
 *   node audit-followups-ui.mjs http://127.0.0.1:3000
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertNoServerErrors } from "./audit-harness.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EMAIL = "admin@elitepos.com";
const PASSWORD = "Admin@123";
const SHOTS = process.cwd() + "/.audit-shots";
const PROFILE = tmpdir() + "/codebuff-followups-profile";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

let chrome = null;
let ws = null;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const failedRequests = [];
const results = [];
// The exact query the Inventory page used (carries selectedWarehouseId), so the
// API comparison is scoped identically instead of counting every warehouse.
let invRequestQuery = "";

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 45000);
  });
}

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return { __err: r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? "") };
  }
  return r.result?.value;
}

async function waitFor(expr, timeout = 30000, interval = 300) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await evalJs(expr);
    if (v && !v.__err) return v;
    await sleep(interval);
  }
  return null;
}

async function nav(path) {
  await send("Page.navigate", { url: BASE + path });
  await waitFor(`document.readyState === 'complete'`, 30000);
  return waitFor(`!!document.body && document.body.innerText.length > 0`, 30000);
}

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r?.data) writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
}

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function login() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await nav("/dashboard");
    if (await waitFor(`location.pathname.startsWith('/dashboard')`, 20000)) return true;
    await nav("/login");
    await sleep(1200);
    if (!(await waitFor(`!!document.querySelector('input[type=email]')`, 25000))) continue;
    await evalJs(`(() => { const e = document.querySelector('input[type=email]'); e.focus(); e.value=''; })()`);
    await send("Input.insertText", { text: EMAIL });
    await evalJs(`(() => { const p = document.querySelector('input[type=password]'); p.focus(); p.value=''; })()`);
    await send("Input.insertText", { text: PASSWORD });
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /sign in/i.test(x.innerText || ''));
      if (b) b.click();
      return !!b;
    })()`);
    if (await waitFor(`location.pathname.startsWith('/dashboard') || location.pathname.startsWith('/pos')`, 30000)) return true;
  }
  return false;
}

/** All StatCard tiles on the page: label -> { value, sub, bar(title) }.
    Targets the shared <StatCard> classes (neu-stat-label / neu-stat-value);
    a previous tracking-wider probe predated that refactor and matched only
    per-row inventory cell labels, never the KPI tiles. */
const CARDS_EXPR = `(() => {
  return [...document.querySelectorAll('.neu-stat-label')].map((p) => {
    const valP = p.nextElementSibling;
    const after = valP ? valP.nextElementSibling : null;
    const bar = p.parentElement ? p.parentElement.querySelector('[role="img"][title]') : null;
    return {
      label: (p.innerText || '').trim(),
      value: valP ? (valP.innerText || '').trim() : null,
      sub: after && after.tagName === 'P' ? (after.innerText || '').trim() : null,
      bar: bar ? bar.getAttribute('title') : null,
    };
  });
})()`;

const num = (s) => Number(String(s ?? "").replace(/[^0-9.-]/g, ""));

async function main() {
  console.log(`\n=== follow-up UI verification against ${BASE} ===\n`);

  const PORT = 9800 + Math.floor(Math.random() * 150);
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--user-data-dir=" + PROFILE,
      "--window-size=1440,1000",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  await sleep(2500);

  let target = null;
  for (let i = 0; i < 20 && !target; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      target = await res.json();
    } catch {
      await sleep(1000);
    }
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("could not open CDP tab");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(`UNCAUGHT: ${d.exception?.description ?? d.text} @ ${d.url}:${d.lineNumber}`);
    }
    if (msg.method === "Network.requestWillBeSent") {
      const url = msg.params?.request?.url || "";
      if (url.includes("/api/inventory?")) invRequestQuery = url.slice(url.indexOf("?"));
    }
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
      failedRequests.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
  });

  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");

  if (!(await login())) throw new Error("login failed");
  console.log("logged in\n");

  /* ── 1. Dashboard ───────────────────────────────────────────── */
  await nav("/dashboard");
  await waitFor(`document.querySelectorAll('.neu-stat-label').length >= 4`, 40000);
  await sleep(1500);
  const cards = await evalJs(CARDS_EXPR);
  await shot("followups-dashboard");
  console.log("  dashboard stat cards:", JSON.stringify((cards || []).filter((c) => /revenue|month|product|restock|dues/i.test(c.label))));
  const byLabel = (re) => (Array.isArray(cards) ? cards.find((c) => re.test(c.label)) : null);

  // The catalog-size tile is labelled "Total Products" (i18n dashboard.totalProducts).
  const productsCard = byLabel(/^Total Products$/i);
  const restockCard = byLabel(/^Needs Restock$/i);
  check("dashboard: Total Products card renders", !!productsCard, productsCard ? `value=${productsCard.value}` : "missing");
  check("dashboard: 'Needs Restock' card renders", !!restockCard, restockCard ? `value=${restockCard.value}` : "missing");

  if (productsCard && restockCard) {
    const products = num(productsCard.value);
    const restock = num(restockCard.value);
    check(
      "dashboard: Needs Restock is a distinct-product count (<= Total Products)",
      restock <= products,
      `restock=${restock} <= products=${products}`
    );
    const split = (restockCard.bar || "").match(/(\d+)\s+out of stock\s+·\s+(\d+)\s+low stock/);
    check("dashboard: card tooltip shows 'N out of stock · N low stock'", !!split, restockCard.bar || "(no bar)");
    if (split) {
      check(
        "dashboard: out + low === headline",
        Number(split[1]) + Number(split[2]) === restock,
        `${split[1]} + ${split[2]} vs ${restock}`
      );
    }
    check(
      "dashboard: sub-caption is the location-level alert count",
      /\d+\s+alerts across\s+\d+\s+location/i.test(restockCard.sub || "") || /all stocked/i.test(restockCard.sub || ""),
      restockCard.sub || "(none)"
    );
  }

  /* ── 1b. Reports → Inventory renders the SAME shared card ──── */
  await nav("/reports/inventory");
  await waitFor(`document.querySelectorAll('.neu-stat-label').length >= 1`, 45000);
  await sleep(1500);
  const reportCards = await evalJs(CARDS_EXPR);
  await shot("followups-reports-inventory");
  const reportProducts = (reportCards || []).find((c) => /^Total Products$/i.test(c.label));
  check("reports/inventory: Total Products card renders", !!reportProducts, reportProducts ? `value=${reportProducts.value}` : "(missing)");
  if (reportProducts && productsCard) {
    check(
      "dashboard and reports/inventory share one card label",
      reportProducts.label === productsCard.label,
      `dashboard="${productsCard.label}" reports="${reportProducts.label}"`
    );
    check(
      "both surfaces share the same sub-caption",
      (reportProducts.sub || "") === (productsCard.sub || ""),
      `dashboard="${productsCard.sub}" reports="${reportProducts.sub}"`
    );
  }

  /* ── 2. Inventory ───────────────────────────────────────────── */
  await nav("/inventory");
  // Wait for the KPI row (server summary) AND a settled stock table, not just
  // any tbody row — the first paint can show a transient/partial table.
  await waitFor(`document.querySelectorAll('.neu-stat-label').length >= 5`, 45000);
  await waitFor(`document.querySelectorAll('table.inventory-table tbody tr').length > 1`, 30000);
  await sleep(2000);
  const invCards = await evalJs(CARDS_EXPR);
  await shot("followups-inventory");
  // KPI tiles come first; the per-row "Stock/Available/Value" labels follow.
  console.log("  inventory KPI cards:", JSON.stringify((invCards || []).slice(0, 6).map((c) => ({ label: c.label, value: c.value }))));
  const invByLabel = (re) => (Array.isArray(invCards) ? invCards.find((c) => re.test(c.label)) : null);
  const tracked = invByLabel(/^Products Tracked$/i);
  const lowKpi = invByLabel(/^Low Stock$/i);
  const outKpi = invByLabel(/^Out of Stock$/i);
  check("inventory: Products Tracked KPI renders", !!tracked, tracked ? `value=${tracked.value}` : "missing");
  check("inventory: Low Stock KPI renders", !!lowKpi, lowKpi ? `value=${lowKpi.value}` : "missing");
  check("inventory: Out of Stock KPI renders", !!outKpi, outKpi ? `value=${outKpi.value}` : "missing");

  const counterExpr = `(() => {
    const m = [...document.querySelectorAll('span')].map(e => (e.innerText||'').trim())
      .filter(s => /\\d+\\s+results?/i.test(s));
    return m.length ? m[0] : null;
  })()`;
  const counter = await evalJs(counterExpr);
  check("inventory: 'N results' counter renders", !!counter, counter || "(none)");

  // API-level proof that nothing is capped at the first page. Scope it to the
  // SAME warehouse the page selected, or we would compare page rows against an
  // all-warehouse total. On a fresh profile the store auto-selects a default
  // warehouse AFTER mount and the page refetches, so the first captured
  // /api/inventory request can predate the selection. The header picker is
  // bound to the same store value — read the settled scope from it.
  const whId = await evalJs(`(() => { const s = document.querySelector('header select'); return s && s.value ? s.value : ""; })()`);
  const scope = whId ? `?warehouseId=${whId}` : "?all=true";
  const withAll = scope.includes("all=true") ? scope : scope + "&all=true";
  const plain = scope.replace(/[?&]all=true/, "").replace(/^\?&?/, "?") || "";
  const api = await evalJs(`(async () => {
    const a = await fetch('/api/inventory${withAll}', { credentials: 'include' }).then(r => r.json());
    const d = await fetch('/api/inventory${plain}', { credentials: 'include' }).then(r => r.json());
    return {
      scope: ${JSON.stringify(withAll)},
      allItems: a.items.length, allTotal: a.total, allPage: a.page, allPageSize: a.pageSize, allPages: a.totalPages,
      allStockRows: a.summary.stockRows, allLow: a.summary.lowStockCount, allOut: a.summary.outOfStockCount,
      defItems: d.items.length, defTotal: d.total, defPageSize: d.pageSize,
    };
  })()`);
  console.log("\n  /api/inventory:", JSON.stringify(api), "\n");
  if (api && !api.__err) {
    // The scope transition (auto-select → refetch) needs a beat; judge the
    // table only once its row count matches the API's in-scope total, or time
    // out and fail with both numbers as the diagnostic.
    await waitFor(`document.querySelectorAll('table.inventory-table tbody tr').length === ${api.allTotal}`, 12000).catch(() => {});
    const domRows = await evalJs(`document.querySelectorAll('table.inventory-table tbody tr').length`);
    // Re-read the counter after the scope settles — the early capture can
    // predate the auto-select refetch.
    const settledCounter = (await evalJs(counterExpr)) || counter;
    // Same for the KPI tiles: re-read after the scope settles.
    const settledCards = (await evalJs(CARDS_EXPR)) || [];
    const sTracked = settledCards.find((c) => /^Products Tracked$/i.test(c.label)) || tracked;
    const sLow = settledCards.find((c) => /^Low Stock$/i.test(c.label)) || lowKpi;
    const sOut = settledCards.find((c) => /^Out of Stock$/i.test(c.label)) || outKpi;
    check("inventory API: all=true returns every in-scope row", api.allItems === api.allTotal && api.allTotal === api.allStockRows, `items=${api.allItems} total=${api.allTotal} stockRows=${api.allStockRows}`);
    check("inventory API: all=true is a single unpaginated page", api.allPage === 1 && api.allPages === 1 && api.allPageSize === api.allTotal, `page=${api.allPage} pages=${api.allPages} pageSize=${api.allPageSize}`);
    check("inventory API: default (no all) is still paged", api.defPageSize === 50 && api.defItems <= 50, `pageSize=${api.defPageSize} items=${api.defItems} total=${api.defTotal}`);
    check(
      "inventory table lists EVERY in-scope row, not just page 1",
      domRows === api.allTotal && (api.allTotal <= 50 || domRows > 50),
      `dom rows=${domRows} scoped total=${api.allTotal} (default page would cap at 50)`
    );
    if (settledCounter) check("inventory: counter matches the in-scope set", num(settledCounter) === api.allTotal, `counter=${num(settledCounter)} api=${api.allTotal}`);
    if (sTracked) check("inventory: Products Tracked matches the API summary", num(sTracked.value) === api.allStockRows, `${sTracked.value} vs ${api.allStockRows}`);
    if (sLow) check("inventory: Low Stock matches the API summary", num(sLow.value) === api.allLow, `${sLow.value} vs ${api.allLow}`);
    if (sOut) check("inventory: Out of Stock matches the API summary", num(sOut.value) === api.allOut, `${sOut.value} vs ${api.allOut}`);
    // The "Restock only" chip badges the same worklist the two KPIs split.
    const chip = await evalJs(`(() => {
      const el = document.querySelector('.filter-chip-count');
      return el ? (el.innerText || '').trim() : null;
    })()`);
    check(
      "inventory: 'Restock only' chip badge === Low + Out KPIs",
      !!chip && num(chip) === api.allLow + api.allOut,
      `chip=${chip} vs ${api.allLow}+${api.allOut}`
    );
    if (restockCard) {
      check(
        "dashboard Needs Restock <= Total Products (distinct-product count)",
        num(restockCard.value) <= num(productsCard?.value ?? 0),
        `${restockCard.value} <= ${productsCard?.value}`
      );
    }
  } else {
    check("inventory API: reachable", false, JSON.stringify(api));
  }

  /* ── 2b. Export menu (CSV must contain every row) ───────────── */
  // Headless Chrome drops blob-URL downloads, so instead of chasing the file on
  // disk we hook URL.createObjectURL and read the exact Blob the page built.
  await evalJs(`(() => {
    if (!window.__patchedBlobs) {
      window.__patchedBlobs = true;
      window.__blobs = [];
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { try { window.__blobs.push(b); } catch {} return orig(b); };
    }
    window.__blobs = [];
    return true;
  })()`);

  // Click THE PAGE'S export button, not the first aria-haspopup button in the
  // DOM — the header user menu, notification bell and theme toggle all match
  // that selector and sit earlier in the document. Scope to <main> and
  // require the Export label.
  const menuOpened = await evalJs(`(() => {
    const b = [...document.querySelectorAll('main button[aria-haspopup="menu"]')].find(x => /export/i.test(x.innerText || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(600);
  const menuItems = await evalJs(`[...document.querySelectorAll('[role="menuitem"]')].map(e => (e.innerText || '').trim())`);
  check("inventory: Export menu opens", !!menuOpened && Array.isArray(menuItems) && menuItems.length > 0, (menuItems || []).join(" | "));
  check("inventory: Export menu offers CSV", Array.isArray(menuItems) && menuItems.some((s) => /^CSV/i.test(s)), (menuItems || []).join(" | "));

  const csvClicked = await evalJs(`(() => {
    const b = [...document.querySelectorAll('[role="menuitem"]')].find(e => /^CSV/i.test(e.innerText || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(2000);
  const csvText = csvClicked
    ? await evalJs(`(async () => {
        const b = (window.__blobs || [])[0];
        return b ? await b.text() : null;
      })()`)
    : null;
  check("inventory: CSV export produced content", !!csvText && typeof csvText === "string", csvClicked ? (csvText ? `${String(csvText).length} chars` : "(no blob)") : "(item not clickable)");
  if (typeof csvText === "string" && csvText) {
    const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
    const dataLines = lines.length - 1; // minus the header row
    check(
      "inventory: exported CSV holds every in-scope row",
      dataLines === api.allTotal,
      `csv data rows=${dataLines} in-scope rows=${api.allTotal}`
    );
  }

  /* ── 3. Settings ────────────────────────────────────────────── */
  await nav("/settings");
  const settings = await waitFor(
    `(() => {
      const p = [...document.querySelectorAll('p')].find(e => /Early restock warnings/i.test(e.innerText || ''));
      if (!p) return null;
      const box = p.closest('div.flex.items-start.justify-between') || p.parentElement?.parentElement;
      const sw = box ? box.querySelector('button[role="switch"]') : null;
      return { label: p.innerText.trim(), switchFound: !!sw, checked: sw ? sw.getAttribute('aria-checked') : null };
    })()`,
    40000
  );
  await shot("followups-settings");
  check("settings: 'Early restock warnings' switch renders", !!settings?.switchFound, settings ? `aria-checked=${settings.checked}` : "not found");

  /* ── 4. Console / network health ────────────────────────────── */
  await sleep(1000);
  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));
  // `next dev` invalidates its own `/_next/static/*` chunks whenever a file is
  // written into the project tree while it runs, so those 404s are a dev-server
  // artifact, not app behaviour. Everything the app actually requests must pass.
  const appFailures = failedRequests.filter((u) => !u.includes("/_next/static/"));
  const devChunk404s = failedRequests.filter((u) => u.includes("/_next/static/"));
  check("no failed requests", appFailures.length === 0, appFailures.slice(0, 4).join(" | "));
  if (devChunk404s.length) {
    console.log(`note: ${devChunk404s.length} dev-only /_next/static chunk 404(s) ignored (HMR churn)`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===\n`);
  if (failed.length) {
    console.log("FAILURES:");
    for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
  }
  // A 5xx is a defect, not a log line — see scripts/audit-harness.mjs.
  const serverErrors = assertNoServerErrors(consoleErrors, { name: "audit-followups-ui" });
  return failed.length + serverErrors;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error("\nHARNESS ERROR:", err?.stack || err);
  exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  await sleep(500);
  process.exit(exitCode);
}
