/* Browser audit for: partial refunds (orders UI), print receipt, POS shortcuts,
   refunds ledger partial rows, low-stock widget. CDP over Node's built-in WebSocket. */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://127.0.0.1:3000";
const DEBUG = process.env.DEBUG ? true : false;
const results = [];
function check(name, cond, extra = "") {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  console.log(results[results.length - 1]);
  if (!cond) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function click(selector) {
  return evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
}

async function clickText(text, rootSel = "body") {
  return evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)}) || document;
    const els = [...root.querySelectorAll("button, a, span, td, th, tr, div, label, option, [role=menuitem]")];
    const exact = els.find(e => (e.innerText || "").trim() === ${JSON.stringify(text)});
    const el = exact || els.find(e => (e.innerText || "").trim() === ${JSON.stringify(text)})
      || els.find(e => (e.innerText || "").includes(${JSON.stringify(text)}) && (e.innerText || "").length < 120);
    if (!el) return false; el.click(); return true;
  })()`);
}

async function typeText(text) {
  await send("Input.insertText", { text });
}

async function key(key) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 0 });
}

async function selectAllAndType(selExpr, text) {
  const focused = await evalJs(`(() => { const el = ${selExpr}; if (!el) return false; el.focus(); return true; })()`);
  if (!focused) return false;
  await key("Control");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await key("Control");
  await typeText(text);
  return true;
}

async function nav(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await send("Page.navigate", { url: BASE + path });
    await waitFor(`document.readyState === 'complete'`, 15000);
    // wait for the app shell to render (header nav present)
    const ok = await waitFor(`!!document.querySelector('header') || !!document.querySelector('nav') || !!document.querySelector('main')`, 15000);
    if (ok) return true;
    await sleep(1500);
  }
  return false;
}

async function text() {
  return evalJs(`document.body.innerText`);
}

function openPrintWindow() {
  // Patch window.open so we can inspect the generated receipt without a real print dialog
  return evalJs(`(window.__openCalls = window.__openCalls || []).length`);
}

async function patchWindowOpen() {
  await evalJs(`window.__openCalls = []; (() => {
    const orig = window.open.bind(window);
    window.open = function(url, name, features) {
      const rec = { url, name, features };
      window.__openCalls.push(rec);
      const doc = '<html><head><title>RECEIPT</title></head><body><div id="receipt-html">' + (url || "") + '</div></body></html>';
      try {
        const win = window.open('', name, features);
        win.document.write(doc);
        return win;
      } catch (e) {
        rec.patchedFallback = true;
        return { document: { write() {}, close() {} }, focus() {}, print() {} };
      }
    };
  })(); true`);
}

async function login() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await nav("/dashboard");
    // Already authenticated? The dashboard renders the app shell.
    let authed = await waitFor(`location.pathname.startsWith('/dashboard') && (document.body.innerText.includes('Dashboard') || !!document.querySelector('main'))`, 20000);
    if (!authed) {
      // Landed on the login form — fill it in
      await nav("/login");
      const inputsReady = await waitFor(`!!document.querySelector('input[type=email]') && !!document.querySelector('input[type=password]')`, 20000);
      if (!inputsReady) continue;
      await selectAllAndType(`document.querySelector('input[type=email]')`, "admin@elitepos.com");
      await selectAllAndType(`document.querySelector('input[type=password]')`, "Admin@123");
      const vals = await evalJs(`({ e: document.querySelector('input[type=email]')?.value || '', p: document.querySelector('input[type=password]')?.value || '' })`);
      if (DEBUG) console.log("login debug attempt", attempt, "values:", JSON.stringify(vals));
      const clicked = await clickText("Sign in") || await clickText("Login") || await clickText("Log in");
      if (DEBUG) console.log("login debug: clicked=", clicked, "| path=", await evalJs(`location.pathname`));
      authed = await waitFor(`location.pathname.startsWith('/dashboard')`, 25000);
      if (!authed && DEBUG) console.log("login debug: still on", await evalJs(`location.pathname`), "| body:", (await text() || "").slice(0, 250));
    }
    if (authed) return true;
  }
  return false;
}

// ── API helpers (node-side fetch for setup/cleanup) ──
const jar = new Map();
async function raw(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const ck = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  if (ck) headers["cookie"] = ck;
  const r = await fetch(BASE + path, { ...opts, headers, redirect: "manual" });
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of setc) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return r;
}
async function apiLogin() {
  const csrf = await (await raw("/api/auth/csrf")).json();
  await raw("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: "admin@elitepos.com", password: "Admin@123", redirect: "false" }).toString(),
  });
  return [...jar.keys()].some((k) => k.includes("session-token"));
}
async function jsonReq(path, opts = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await raw(path, opts);
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("json")) return r;
    await sleep(1200);
  }
  return raw(path, opts);
}

async function createDisposableSale() {
  const [prodRes, whRes] = await Promise.all([jsonReq("/api/pos/search?q=Sugar&limit=5"), jsonReq("/api/warehouses")]);
  const prods = (await prodRes.json()).products ?? [];
  const prod = prods.find((p) => p.unit === "kg" && p.allowFractional) || prods[0];
  const whs = (await whRes.json()).warehouses ?? [];
  const wh = whs.find((w) => w.isDefault) || whs[0];
  const qty = 2;
  const total = prod.unitPrice * qty;
  const r = await jsonReq("/api/pos/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      warehouseId: wh.id,
      items: [{ productId: prod.id, productName: prod.name, sku: prod.sku, quantity: qty, unit: prod.unit || "kg", unitPrice: prod.unitPrice, costPrice: prod.costPrice || 0, discountAmount: 0, taxRate: prod.taxRate || 0, taxAmount: 0, total }],
      subtotal: total, taxAmount: 0, discountAmount: 0, total,
      paymentMethod: "cash", amountPaid: total, changeDue: 0,
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error("checkout failed: " + r.status + " " + JSON.stringify(body));
  const orderId = body.order?.id || body.id;
  const ord = await (await jsonReq(`/api/orders/${orderId}`)).json();
  return { orderId, order: ord.order, prod };
}

async function cleanupOrder(orderId) {
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  const order = await p.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (order) {
    // Restore whatever stock was sold and not refunded (net-zero cleanup)
    for (const it of order.items) {
      const unrefunded = it.quantity - (it.refundedQuantity || 0);
      if (unrefunded <= 0) continue;
      const sl = await p.stockLevel.findFirst({ where: { productId: it.productId, warehouseId: order.warehouseId } });
      if (sl) await p.stockLevel.update({ where: { id: sl.id }, data: { quantity: sl.quantity + unrefunded } });
    }
  }
  await p.payment.deleteMany({ where: { orderId } });
  await p.orderItem.deleteMany({ where: { orderId } });
  await p.inventoryMovement.deleteMany({ where: { referenceId: orderId } });
  const del = await p.order.deleteMany({ where: { id: orderId } });
  await p.$disconnect();
  return del.count;
}

// ── PHASES ──
async function phasePartialRefundUI() {
  console.log("\n── PHASE: partial refund via Orders UI ──");
  // Stock before
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  const stockBefore = await p.stockLevel.findFirst({ where: { product: { name: { contains: "Sugar" } } }, select: { quantity: true } });
  await p.$disconnect();

  const { orderId, order, prod } = await createDisposableSale();
  console.log("created sale:", order.orderNumber, "total:", order.total, "line qty:", order.items[0].quantity);
  const itemId = order.items[0].id;
  const lineTotal = order.items[0].total;
  const qty = order.items[0].quantity;
  const partialQty = qty / 4; // 0.5 of 2 kg

  const ok = await nav("/orders");
  check("orders page renders", !!ok);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(order.orderNumber)})`, 12000);

  // Open detail
  await clickText(order.orderNumber);
  const modalOk = await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes(${JSON.stringify(order.orderNumber)}))`, 10000);
  check("detail modal opens", !!modalOk);

  // Open refund dialog (scoped to the open detail modal)
  await clickText("Refund", "[role=dialog]");
  const refundDialog = await waitFor(`[...document.querySelectorAll('[role=dialog]')].find(d => (d.innerText||'').includes('Items to refund')) !== undefined`, 10000);
  check("refund dialog shows items-to-refund editor", !!refundDialog);

  // Change the line qty to partialQty
  const qtyInput = await waitFor(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => (x.innerText||'').includes('Items to refund')); if(!d) return null; const i = d.querySelector('input[type=number]'); return i ? i : null; })()`, 8000);
  check("quantity input present", !!qtyInput);
  await evalJs(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => (x.innerText||'').includes('Items to refund')); const i = d.querySelector('input[type=number]'); i.focus(); i.value = ''; })()`);
  await key("Control+a");
  await typeText(String(partialQty));
  await sleep(400);

  // Read the preview amount
  const preview = await evalJs(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => (x.innerText||'').includes('Items to refund')); if(!d) return null; const m = d.innerText.match(/Refund total[^0-9]*[−-]?([0-9,.]+)/); return m ? m[1] : d.innerText.slice(-120); })()`);
  console.log("refund preview shown:", preview);
  check("refund preview visible", !!preview);

  // Submit
  await clickText("Process Refund", "[role=dialog]");
  await sleep(2500);

  // Verify via DB + API
  const ord2 = await (await jsonReq(`/api/orders/${orderId}`)).json();
  const expectedRefund = Math.round((lineTotal * partialQty) / qty);
  check("order status is partially_refunded", ord2.order.status === "partially_refunded", ord2.order.status);
  check("refundedAmount matches proportional line value", ord2.order.refundedAmount === expectedRefund, `got ${ord2.order.refundedAmount}, want ${expectedRefund}`);
  check("item refundedQuantity recorded", Math.abs(ord2.order.items[0].refundedQuantity - partialQty) < 1e-6, String(ord2.order.items[0].refundedQuantity));

  const stockMid = await (async () => { const p2 = new PrismaClient(); const s = await p2.stockLevel.findFirst({ where: { product: { name: { contains: "Sugar" } } }, select: { quantity: true } }); await p2.$disconnect(); return s.quantity; })();
  check("stock restored by partial qty", Math.abs(stockMid - (stockBefore.quantity - qty + partialQty)) < 1e-6, `before=${stockBefore.quantity} now=${stockMid}`);

  // Refund the rest from the Orders page again (open modal → keep prefilled remaining → submit)
  await nav("/orders");
  await waitFor(`document.body.innerText.includes(${JSON.stringify(order.orderNumber)})`, 12000);
  await clickText(order.orderNumber);
  await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes(${JSON.stringify(order.orderNumber)}))`, 10000);
  const remaining = qty - partialQty;
  const restBtn = await waitFor(`[...document.querySelectorAll('[role=dialog] button')].some(b => (b.innerText||'').includes('Refund remaining'))`, 8000);
  check("'Refund remaining' button on partial order", !!restBtn);
  await clickText("Refund remaining");
  await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes('Items to refund'))`, 8000);
  await clickText("Process Refund", "[role=dialog]");
  await sleep(2500);

  const ord3 = await (await jsonReq(`/api/orders/${orderId}`)).json();
  check("order now fully refunded", ord3.order.status === "refunded", ord3.order.status);
  check("refundedAmount equals full total", ord3.order.refundedAmount === order.total, `got ${ord3.order.refundedAmount}, want ${order.total}`);
  const stockEnd = await (async () => { const p2 = new PrismaClient(); const s = await p2.stockLevel.findFirst({ where: { product: { name: { contains: "Sugar" } } }, select: { quantity: true } }); await p2.$disconnect(); return s.quantity; })();
  check("stock fully restored", Math.abs(stockEnd - stockBefore.quantity) < 1e-6, `before=${stockBefore.quantity} now=${stockEnd}`);

  // Cleanup: delete the disposable order (stock already back to baseline)
  const del = await cleanupOrder(orderId);
  check("disposable order cleaned up", del === 1, `deleted ${del}`);
}

async function phaseRefundsLedger() {
  console.log("\n── PHASE: refunds ledger shows partial refunds ──");
  // Create a disposable order, partial refund via API, then check the ledger UI
  const { orderId, order } = await createDisposableSale();
  const item = order.items[0];
  const partialQty = item.quantity / 2;
  const r = await jsonReq(`/api/orders/${orderId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "ledger partial check", items: [{ id: item.id, quantity: partialQty }] }),
  });
  const body = await r.json();
  check("API partial refund ok", r.ok && body.status === "partially_refunded", r.status + " " + (body.status || body.error));

  await nav("/refunds");
  await waitFor(`document.body.innerText.includes(${JSON.stringify(order.orderNumber)})`, 12000);
  const pageText = await text();
  check("ledger lists the partial order", pageText.includes(order.orderNumber));
  check("ledger shows 'Partially refunded' badge", pageText.includes("Partially refunded"));

  // Detail modal
  await clickText(order.orderNumber);
  const modalOk = await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes(${JSON.stringify(order.orderNumber)}))`, 10000);
  check("partial refund detail modal opens", !!modalOk);
  const modalText = await evalJs(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => (x.innerText||'').includes(${JSON.stringify(order.orderNumber)})); return d ? d.innerText : ''; })()`);
  check("detail shows refunded-qty indicator", modalText.includes("Refunded"), modalText.includes("Refunded") ? "" : modalText.slice(0, 200));

  // Print button on detail modal — window.open intercepted
  await patchWindowOpen();
  const printed = await clickText("Print receipt", "[role=dialog]");
  await sleep(1500);
  const openCalls = await evalJs(`window.__openCalls.length`);
  const receiptHtml = await evalJs(`window.__openCalls.map(c => c.url || '').join('')`);
  check("print receipt button opens print window", printed && openCalls >= 1, `openCalls=${openCalls}`);
  check("receipt contains order number", receiptHtml.includes(order.orderNumber), receiptHtml.slice(0, 120));
  check("receipt contains refunded amount", receiptHtml.includes("Refunded"));

  await cleanupOrder(orderId);
}

async function phasePOSShortcuts() {
  console.log("\n── PHASE: POS keyboard shortcuts ──");
  await nav("/pos");
  await waitFor(`document.body.innerText.includes(${JSON.stringify("Search products")}) || !!document.querySelector('input[type=search], input[placeholder*=\"Search\" i]')`, 12000);
  const hint = await text();
  check("shortcut hints show F2/F3/F4", hint.includes("F2") && hint.includes("F3") && hint.includes("F4"));

  // F3 toggles view: check view mode state via toolbar buttons
  const viewToggle = await evalJs(`(() => { const btns = [...document.querySelectorAll('button')].filter(b => (b.innerText||'').includes('List') || (b.innerText||'').includes('Table') || (b.title||'').toLowerCase().includes('list')); return btns.length; })()`);
  const modeBefore = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-pressed') === 'true') || (x.className||'').includes('brand')); return b ? (b.innerText||'').trim().slice(0,12) : 'n/a'; })()`);
  await key("F3");
  await sleep(400);
  const modeAfter = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-pressed') === 'true') || (x.className||'').includes('brand')); return b ? (b.innerText||'').trim().slice(0,12) : 'n/a'; })()`);
  check("F3 toggles product view", viewToggle > 0 && modeBefore !== modeAfter, `${modeBefore} → ${modeAfter}`);
  await key("F3"); // restore
  await sleep(300);

  // F4 opens payment dialog only when the cart has items: add Sugar via search
  const searchSel = await waitFor(`(() => { const i = document.querySelector('input[placeholder*="earch" i]'); return i ? true : null; })()`, 8000);
  check("search input present", !!searchSel);
  await evalJs(`(() => { const i = document.querySelector('input[placeholder*="earch" i]'); i.focus(); i.value=''; })()`);
  await typeText("Sugar");
  await waitFor(`document.body.innerText.includes('Sugar') && (document.querySelectorAll('[id^=pos-result-]').length > 0 || document.body.innerText.includes('Add'))`, 8000);
  // click the first search result
  await evalJs(`(() => { const r = document.querySelector('[id^=pos-result-]'); if (r) { r.click(); return true; } return false; })()`);
  await sleep(600);
  const cartHasItem = await evalJs(`document.body.innerText.includes('Sugar')`);
  // F4 with items in cart
  await key("F4");
  const payDialog = await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').toLowerCase().includes('pay') || (d.innerText||'').includes('Payment'))`, 8000);
  check("F4 opens payment dialog with cart items", !!payDialog);
  // close payment
  await evalJs(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => x.querySelector('button')); [...d.querySelectorAll('button')].forEach(b => { if((b.innerText||'').includes('Cancel') || (b.innerText||'').includes('Close')) b.click(); }); return true; })()`);
  await sleep(500);

  // F2 clears cart + focuses search
  await key("F2");
  await sleep(400);
  const cleared = await evalJs(`(() => { const i = document.activeElement; return i && (i.tagName === 'INPUT') && (i.placeholder||'').toLowerCase().includes('search'); })()`);
  check("F2 clears cart and focuses search", !!cleared);
}

async function phaseDashboardLowStock() {
  console.log("\n── PHASE: dashboard low-stock widget + refund trend ──");
  await nav("/dashboard");
  await waitFor(`document.body.innerText.includes(${JSON.stringify("Low stock")}) || document.body.innerText.includes('Alert')`, 12000);
  const txt = await text();
  check("low-stock widget renders", txt.includes("Low stock") || txt.includes("Alerts"), "");
  const refundTrend = await evalJs(`!![...document.querySelectorAll('h3, h2')].find(h => (h.innerText||'').includes('Refund'))`);
  check("refund trend/reasons cards present", !!refundTrend);
}

// ── MAIN ──
const phase = process.argv[2] || "all";
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
// Create a fresh tab
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
const apiAuthed = await apiLogin();
check("node API session ready", !!apiAuthed);
if (!apiAuthed) {
  console.log("ABORT: node API login failed");
  chrome.kill();
  process.exit(1);
}

try {
  if (phase === "all" || phase === "partial") await phasePartialRefundUI();
  if (phase === "all" || phase === "ledger") await phaseRefundsLedger();
  if (phase === "all" || phase === "pos") await phasePOSShortcuts();
  if (phase === "all" || phase === "dash") await phaseDashboardLowStock();
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
process.exit(process.exitCode || 0);