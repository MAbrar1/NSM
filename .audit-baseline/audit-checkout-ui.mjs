/* CHECKOUT UI FLOW TEST
   Drives the real POS checkout in headless Chrome and reports exactly which
   step fails: add to cart -> Pay -> payment modal -> Process Payment.

   Captures, at every step:
     • the POST /api/pos/checkout status + response body (verbatim)
     • console errors and uncaught exceptions
     • visible toast/inline error text
     • a screenshot of the final state

   Cleans up the order it creates (deletes it and restores stock, net-zero).

   Usage: node audit-checkout-ui.mjs [baseUrl]   (default http://127.0.0.1:3001)
*/
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const BASE = process.argv[2] || "http://127.0.0.1:3001";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EMAIL = "admin@elitepos.com";
const PASSWORD = "Admin@123";
const SHOTS = process.cwd() + "/.audit-shots";
const PROFILE = tmpdir() + "/codebuff-checkout-profile";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

let chrome = null;
let ws = null;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const failedRequests = [];
const failedById = new Map();
const badScriptIds = [];
/** Only orders THIS run actually created (see cleanup). */
const createdOrderIds = new Set();
const checkoutResponses = [];

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
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    return { __err: r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? "") };
  }
  return r.result?.value;
}

async function waitFor(expr, timeout = 15000, interval = 300) {
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
  return waitFor(`!!document.querySelector('main')`, 30000);
}

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r?.data) writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
}

/** Every visible toast-ish string on the page. */
const toastExpr = `(() => {
  const sel = '[role="status"],[role="alert"],[data-sonner-toast],.toast,[data-radix-toast]';
  return [...document.querySelectorAll(sel)].map(e => (e.innerText || '').trim()).filter(Boolean);
})()`;

async function login() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await nav("/pos");
    let authed = await waitFor(`location.pathname.startsWith('/pos')`, 20000);
    if (!authed) {
      await nav("/login");
      await sleep(1500);
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
      authed = await waitFor(`location.pathname.startsWith('/pos') || location.pathname.startsWith('/dashboard')`, 30000);
    }
    if (authed) return true;
  }
  return false;
}

const CARD = `.pos-grid > [role="button"]`;
const addProbe = {};

async function addLine() {
  // First paint of /pos can take a while under `next dev` (route compile).
  const ready = await waitFor(`document.querySelectorAll('${CARD}').length > 0`, 45000, 500);
  if (!ready) return false;
  for (let i = 0; i < 8; i++) {
    if (!(await evalJs(`document.querySelectorAll('${CARD}').length > 0`))) {
      await sleep(1000);
      continue;
    }
    const clickProbe = await evalJs(`(() => {
      const all = [...document.querySelectorAll('${CARD}')];
      // Prefer a whole-unit product: unit-aware (weight) products open a
      // quantity dialog, which needs extra automation. Plain string checks on
      // purpose — backslashes are consumed by this template literal.
      const pcs = all.filter(x => {
        const t = (x.innerText || '').toLowerCase();
        return !(t.indexOf('/ l') >= 0 || t.indexOf('/ kg') >= 0 || t.indexOf('/ g') >= 0 || t.indexOf('/ ml') >= 0 || t.indexOf('per ') >= 0);
      });
      const pool = pcs.length ? pcs : all;
      const c = pool.find(x => x.getAttribute('aria-disabled') !== 'true') || pool[0];
      if (!c) return { clicked: false, total: all.length };
      const info = { clicked: true, total: all.length, tag: c.tagName, role: c.getAttribute('role'), ariaDisabled: c.getAttribute('aria-disabled'), text: (c.innerText || '').slice(0, 120) };
      c.click();
      return info;
    })()`);
    if (i === 0) addProbe.card = clickProbe;
    if (i === 0) await evalJs(`(() => { const h = [...document.querySelectorAll('h2')].find(x => /^quantity$/i.test((x.textContent||'').trim())); if (!h) return false; const panel = h.closest('[role="dialog"]'); if (!panel) return false; return { buttons: [...panel.querySelectorAll('button')].map(b => (b.innerText||'').trim() + (b.disabled ? ' [disabled]' : '')), inputs: [...panel.querySelectorAll('input')].map(i => i.value) }; })()`).then((v) => { addProbe.quantityDialog = v; });
    await sleep(500);
    const afterClick = await evalJs(`(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].map(d => (d.innerText || '').slice(0, 80));
      const heads = [...document.querySelectorAll('h2')].map(h => (h.textContent || '').trim()).slice(0, 4);
      const pay = [...document.querySelectorAll('button')].find(b => /^pay/i.test((b.innerText || '').trim()));
      return { dialogs: dlg, headings: heads, payFound: !!pay, payDisabled: pay ? pay.disabled : null };
    })()`);
    if (i === 0) addProbe.afterClick = afterClick;
    await evalJs(`(() => {
      const h = [...document.querySelectorAll('h2')].find(x => /^quantity$/i.test((x.textContent||'').trim()));
      if (!h) return false;
      const panel = h.closest('[role="dialog"]') || h.parentElement?.parentElement;
      if (!panel) return false;
      // React-controlled inputs ignore a plain .value assignment — go through
      // the native setter so onChange fires and the Add button enables.
      const num = panel.querySelector('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"], input:not([type])');
      if (num) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(num, '1');
        num.dispatchEvent(new Event('input', { bubbles: true }));
        num.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const ok = [...panel.querySelectorAll('button')].find(b => /add to order|^add$/i.test(b.innerText || ''));
      if (ok && !ok.disabled) { ok.click(); return true; }
      return false;
    })()`);
    const ready = await waitFor(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => /^pay/i.test((x.innerText||'').trim())); return b && !b.disabled; })()`,
      6000
    );
    if (ready) return true;
  }
  return false;
}

/**
 * A SyntaxError in a bundle is reported as <chunkUrl>:<line>:<col>. Fetch that
 * chunk in-page (same origin) and print the offending line with context — the
 * only reliable way to see what the bundler actually emitted.
 */
async function explainScriptErrors() {
  for (const bad of badScriptIds.slice(0, 3)) {
    try {
      const src = await send("Debugger.getScriptSource", { scriptId: bad.scriptId });
      const text = String(src?.scriptSource ?? "");
      console.log(`\n!! failing script ${bad.scriptId} (${String(bad.url).slice(0, 90)}) — ${text.length} chars`);
      // Locate the first line that does not parse on its own.
      const linesOf = text.split("\n");
      console.log(`   reported at line ${bad.line}, col ${bad.col}`);
      for (let n = Math.max(0, (bad.line ?? 1) - 4); n < Math.min(linesOf.length, (bad.line ?? 1) + 3); n++) {
        console.log(`   ${n + 1}| ${linesOf[n].slice(0, 300)}`);
      }
    } catch (e) {
      console.log(`   (getScriptSource failed: ${e.message})`);
    }
  }
  const re = /(https?:\/\/[^\s:]+\/_next\/static\/chunks\/[^\s:]+):(\d+):(\d+)/;
  for (const err of [...new Set(consoleErrors)]) {
    const m = re.exec(err);
    if (!m) continue;
    const [, url, lineNo] = m;
    const path = new URL(url).pathname;
    try {
      const line = await evalJs(`fetch(${JSON.stringify(path)}).then(r => r.text()).then(t => {
        var L = t.split('\\n');
        var n = ${Number(lineNo)};
        return { total: L.length, target: L[n - 1] ? L[n - 1].slice(0, 400) : '(line missing)', around: L.slice(Math.max(0, n - 3), n + 2).map(function (x) { return x.slice(0, 200); }) };
      })`);
      console.log(`\n!! bundle syntax error in ${path}:${lineNo}`);
      console.log("   chunk lines:", line.total);
      console.log("   offending line:", line.target);
      console.log("   around:");
      line.around.forEach((l, i) => console.log(`     ${lineNo - 2 + i}: ${l}`));
    } catch (e) {
      console.log(`   (could not fetch ${path}: ${e.message})`);
    }
  }
}

async function dumpFailures() {
  if (failedRequests.length === 0) return console.log("(none)");
  await sleep(500); // let the in-flight body grabs settle
  const seen = new Set();
  for (const f of failedRequests) {
    const key = `${f.status} ${f.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`· ${key}`);
    console.log(`    ${String(f.body || "(body unavailable)").replace(/\s+/g, " ").slice(0, 600)}`);
  }
}

async function main() {
  console.log(`\n=== checkout UI flow against ${BASE} ===\n`);

  const PORT = 9700 + Math.floor(Math.random() * 200);
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      // OUTSIDE the project on purpose: a Chrome profile inside the watched tree
      // makes `next dev` recompile in an endless loop and truncate .next, which
      // 500s every API route (that is what broke checkout).
      "--user-data-dir=" + PROFILE,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  await sleep(2500);

  // Like the other audit scripts: open OUR OWN tab via /json/new and attach to
  // it. Attaching to the initial about:blank page leaves Page.navigate hanging.
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
      const where = d.url || d.scriptId || "?";
      consoleErrors.push(
        `UNCAUGHT: ${d.exception?.description ?? d.text} @ ${where}:${d.lineNumber}:${d.columnNumber}`
      );
      // Keep the scriptId: a syntax error inside an eval'd module can be
      // resolved to its actual source via Debugger.getScriptSource().
      if (d.scriptId) badScriptIds.push({ scriptId: d.scriptId, url: d.url, line: d.lineNumber, col: d.columnNumber });
    }
    // Parse errors surface here WITH their source URL — the only way to find a
    // bundle that fails to evaluate.
    // Bodies are evicted quickly — grab them the moment the load finishes.
    if (msg.method === "Network.loadingFinished") {
      const entry = failedById.get(msg.params.requestId);
      if (entry && entry.body === null) {
        send("Network.getResponseBody", { requestId: msg.params.requestId })
          .then((b) => {
            entry.body = String(b?.body ?? "");
          })
          .catch(() => {
            entry.body = "(unavailable)";
          });
      }
    }
    if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      if (e.level === "error") {
        consoleErrors.push(`LOG[${e.source}] ${e.text} @ ${e.url ?? "?"}:${e.lineNumber ?? "?"}`);
      }
    }
    if (msg.method === "Network.responseReceived") {
      const r = msg.params.response;
      if (r.status >= 400) {
        const entry = { status: r.status, url: r.url.replace(BASE, ""), requestId: msg.params.requestId, body: null };
        failedRequests.push(entry);
        failedById.set(msg.params.requestId, entry);
      }
      if (r.url.includes("/api/pos/checkout")) {
        checkoutResponses.push({ requestId: msg.params.requestId, status: r.status, url: r.url });
      }
    }
  });

  await send("Network.enable");
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("Debugger.enable");

  if (!(await login())) {
    console.log("✖ could not log in via the UI");
    await shot("checkout-ui-login-failed");
    process.exitCode = 1;
    return;
  }
  // login() may land on /dashboard — always come back to /pos explicitly.
  await nav("/pos");
  await waitFor(`location.pathname === '/pos'`, 20000);
  // The welcome tour is a first-visit modal that covers the whole app (by
  // design, keyed on localStorage). A fresh browser profile sees it, so mark it
  // seen and reload — otherwise it sits over the POS and blocks every click.
  await evalJs(`localStorage.setItem('pos_welcome_seen_v1','1')`);
  await nav("/pos");
  const onPos = await waitFor(`location.pathname === '/pos'`, 20000);
  const welcomeGone = await evalJs(`![...document.querySelectorAll('[role="dialog"]')].some(d => /welcome to your store/i.test(d.innerText || ''))`);
  console.log(`1. logged in, pathname=${await evalJs(`location.pathname`)} (onPos=${!!onPos}, welcomeDismissed=${welcomeGone})`);

  // Warm the routes /pos needs — the first hit can 500/fail while the dev
  // server compiles the route, which otherwise flakes the grid load.
  for (const p of [
    "/api/pos/search?limit=1",
    "/api/categories",
    "/api/settings",
    "/api/warehouses",
    "/api/products/lookup?status=low,out&limit=1",
  ]) {
    const st = await evalJs(`fetch(${JSON.stringify(p)}).then(r => r.status).catch(() => 0)`);
    if (st !== 200) console.log(`   ⚠ warm-up ${p} -> ${st}`);
    await sleep(400);
  }

  const added = await addLine();
  console.log(`2. add to cart: ${added ? "OK" : "FAILED"}`);
  if (!added) {
    const diag = await evalJs(`(() => ({
      href: location.href,
      readyState: document.readyState,
      htmlLen: document.documentElement.outerHTML.length,
      bodyLen: (document.body?.innerText || '').length,
      hasMain: !!document.querySelector('main'),
      cards: document.querySelectorAll('.pos-grid > [role="button"]').length,
      gridEls: document.querySelectorAll('.pos-grid').length,
      text: (document.body?.innerText || '').slice(0, 400),
      scripts: document.querySelectorAll('script').length,
      mainDisplay: document.querySelector('main') ? getComputedStyle(document.querySelector('main')).display : null,
      mainRect: (() => { const m = document.querySelector('main'); if (!m) return null; const r = m.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      outline: (function walk(el, depth) {
        if (depth > 3 || !el) return '';
        var kids = [].slice.call(el.children, 0, 6).map(function (c) { return walk(c, depth + 1); }).filter(Boolean).join(', ');
        var cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2).join('.');
        return el.tagName.toLowerCase() + '.' + cls + (kids ? '(' + kids + ')' : '');
      })(document.body, 0).slice(0, 1200),
    }))()`);
    console.log("   page state:", JSON.stringify(diag, null, 2));
    console.log("\n--- add-to-cart probe ---");
    console.log("card:", JSON.stringify(addProbe.card));
    console.log("quantity dialog:", JSON.stringify(addProbe.quantityDialog));
    console.log("after click:", JSON.stringify(addProbe.afterClick));
    console.log("\n--- console errors ---");
    console.log(consoleErrors.length ? consoleErrors.slice(0, 10).map((e) => "· " + e.slice(0, 400)).join("\n") : "(none)");
    await explainScriptErrors();
    console.log("\n--- failed requests (with body) ---");
    await dumpFailures();
    await shot("checkout-ui-add-failed");
    process.exitCode = 1;
    return;
  }

  const opened = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^pay/i.test((x.innerText||'').trim()) && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  console.log(`3. Pay button opens modal: ${opened ? "OK" : "FAILED"}`);
  if (!opened) {
    await shot("checkout-ui-pay-failed");
    process.exitCode = 1;
    return;
  }
  await waitFor(`document.querySelectorAll('.pos-pay-tile').length === 4`, 10000);
  await shot("checkout-ui-payment-modal");

  // Cash tile + exact amount so the modal is in a valid state to submit.
  await evalJs(`(() => {
    const cash = [...document.querySelectorAll('.pos-pay-tile')].find(t => /cash/i.test(t.innerText || ''));
    if (cash) cash.click();
    return !!cash;
  })()`);
  await sleep(400);
  const exactClicked = await evalJs(`(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find(d => /process payment/i.test(d.innerText || ''));
    const scope = dlg || document;
    const exact = [...scope.querySelectorAll('button')].find(b => /^exact$/i.test((b.innerText||'').trim()));
    if (exact) exact.click();
    return !!exact;
  })()`);
  console.log(`   "Exact" amount chip clicked: ${exactClicked}`);
  await sleep(500);

  // Arm the checkout watcher before submitting.
  const before = checkoutResponses.length;
  // Scope to the OPEN payment dialog — the cart's "Pay" button sits behind the
  // overlay and clicking it does nothing, which looks exactly like a dead
  // submit button when you are automating by text match.
  const submitInfo = await evalJs(`(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')]
      .find(d => /process payment/i.test(d.innerText || ''));
    if (!dlg) return { scoped: false };
    const buttons = [...dlg.querySelectorAll('button')].map(b => (b.innerText || '').trim() + (b.disabled ? ' [disabled]' : ''));
    const b = [...dlg.querySelectorAll('button')]
      .filter(x => /complete payment|save with due/i.test(x.innerText || ''))
      .find(x => !x.disabled);
    if (!b) return { scoped: true, buttons, clicked: false };
    b.click();
    return { scoped: true, buttons, clicked: true, label: (b.innerText || '').trim() };
  })()`);
  console.log("4. submit:", JSON.stringify(submitInfo));

  await waitFor(`(() => {
    const t = document.body.innerText;
    return /payment complete|transaction completed|receipt|insufficient|failed|error/i.test(t);
  })()`, 25000);
  await sleep(1500);
  await shot("checkout-ui-after-submit");

  console.log("\n--- checkout request/response ---");
  const seen = checkoutResponses.slice(before);
  if (seen.length === 0) {
    console.log("(no POST /api/pos/checkout was made — the client never submitted)");
  }
  for (const c of seen) {
    console.log(`HTTP ${c.status}  POST /api/pos/checkout`);
    try {
      const b = await send("Network.getResponseBody", { requestId: c.requestId });
      const txt = String(b.body ?? "");
      console.log("body:", txt.slice(0, 1200));
      // Track the exact order so cleanup touches nothing else.
      try {
        const parsed = JSON.parse(txt);
        if (parsed?.order?.id) createdOrderIds.add(parsed.order.id);
      } catch {
        /* non-JSON body is already reported above */
      }
    } catch (e) {
      console.log("(could not read body:", e.message + ")");
    }
  }

  const toasts = await evalJs(toastExpr);
  console.log("\n--- toasts/alerts ---");
  console.log(toasts && toasts.length ? toasts.map((t) => "· " + t).join("\n") : "(none)");

  console.log("\n--- console errors ---");
  console.log(consoleErrors.length ? consoleErrors.slice(0, 12).map((e) => "· " + e.slice(0, 300)).join("\n") : "(none)");

  console.log("\n--- failed requests (with body) ---");
  await dumpFailures();

  // ── cleanup: remove ONLY the orders this run created, restore their stock ──
  // (Never match by date: that would delete real sales made while the test ran.)
  if (createdOrderIds.size === 0) {
    console.log("\nnothing to clean up (no order was created)");
  }
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  try {
    for (const id of createdOrderIds) {
      const o = await p.order.findUnique({ where: { id }, include: { items: true } });
      if (!o) continue;
      for (const it of o.items) {
        const un = it.quantity - (it.refundedQuantity || 0);
        if (un <= 0) continue;
        await p.stockLevel.updateMany({
          where: { productId: it.productId, variantId: it.variantId, warehouseId: o.warehouseId },
          data: { quantity: { increment: un } },
        });
      }
      await p.inventoryMovement.deleteMany({ where: { referenceId: o.id } });
      await p.payment.deleteMany({ where: { orderId: o.id } });
      await p.orderItem.deleteMany({ where: { orderId: o.id } });
      await p.order.delete({ where: { id: o.id } });
      await p.auditLog.deleteMany({ where: { entityId: o.id } });
      console.log(`\ncleaned up test order ${o.orderNumber} (+stock restored)`);
    }
  } finally {
    await p.$disconnect();
  }
}

main()
  .catch((e) => {
    console.error("test crashed:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      ws?.close();
    } catch {}
    try {
      chrome?.kill();
    } catch {}
  });
