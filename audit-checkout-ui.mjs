/* CHECKOUT UI FLOW TEST
   Drives the real POS checkout in headless Chrome and reports exactly which
   step fails: add to cart -> Pay -> payment modal -> Process Payment.

   Captures, at every step:
     • the POST /api/pos/checkout status + response body (verbatim)
     • console errors and uncaught exceptions
     • visible toast/inline error text
     • a screenshot of the final state

   Cleans up the order it creates (deletes it and restores stock, net-zero).

   The CDP plumbing comes from scripts/audit-harness.mjs, including the "add a
   line to the cart" driver this script used to own a copy of. The Chrome
   profile lives outside the project there — putting it inside the watched tree
   is what used to 500 every API route during a run.

   Usage: node audit-checkout-ui.mjs [baseUrl]   (default: harness default, http://localhost:3000)
*/
import { createHarness, sleep, POS } from "./scripts/audit-harness.mjs";

const h = await createHarness({
  name: "checkout",
  base: process.argv[2],
  loginPath: "/pos",
  debugger: true,
  waitForTimeout: 15000,
  warmupPaths: [
    "/api/pos/search?limit=1",
    "/api/categories",
    "/api/settings",
    "/api/warehouses",
    "/api/products/lookup?status=low,out&limit=1",
  ],
});

const { evalJs, waitFor, nav, shot, send, consoleErrors, pos } = h;
const BASE = h.base;

/* ── run-local diagnostics ──
   `consoleErrors` comes from the harness; these are the extra channels this
   script needs to explain a failure. */
const failedRequests = [];
const failedById = new Map();
const badScriptIds = [];
/** Only orders THIS run actually created (see cleanup). */
const createdOrderIds = new Set();
const checkoutResponses = [];

h.on("Network.responseReceived", ({ response, requestId }) => {
  if (response?.status >= 400) {
    const entry = { status: response.status, url: response.url.replace(BASE, ""), requestId, body: null };
    failedRequests.push(entry);
    failedById.set(requestId, entry);
  }
  if (response?.url.includes("/api/pos/checkout")) {
    checkoutResponses.push({ requestId, status: response.status, url: response.url });
  }
});

// Bodies are evicted quickly — grab them the moment the load finishes.
h.on("Network.loadingFinished", ({ requestId }) => {
  const entry = failedById.get(requestId);
  if (entry && entry.body === null) {
    send("Network.getResponseBody", { requestId })
      .then((b) => {
        entry.body = String(b?.body ?? "");
      })
      .catch(() => {
        entry.body = "(unavailable)";
      });
  }
});

// Keep the scriptId: a syntax error inside an eval'd module can be resolved to
// its actual source via Debugger.getScriptSource().
h.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  if (exceptionDetails?.scriptId) {
    badScriptIds.push({
      scriptId: exceptionDetails.scriptId,
      url: exceptionDetails.url,
      line: exceptionDetails.lineNumber,
      col: exceptionDetails.columnNumber,
    });
  }
});

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
  const re = /(https?:\/\/[^\s:]+)\/_next\/static\/chunks\/([^\s:]+):(\d+):(\d+)/;
  for (const err of [...new Set(consoleErrors)]) {
    const m = re.exec(String(err));
    if (!m) continue;
    const [, origin, chunk, lineNo] = m;
    const path = `/_next/static/chunks/${chunk}`;
    try {
      const line = await evalJs(`fetch(${JSON.stringify(origin + path)}).then(r => r.text()).then(t => {
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

/* ─────────────── MAIN ─────────────── */
console.log(`\n=== checkout UI flow against ${BASE} ===\n`);

if (!(await h.login())) {
  console.log("✖ could not log in via the UI");
  await shot("checkout-ui-login-failed");
  process.exitCode = 1;
  await h.finish();
  process.exit(1);
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
const welcomeGone = await evalJs(
  `![...document.querySelectorAll('[role="dialog"]')].some(d => /welcome to your store/i.test(d.innerText || ''))`
);
console.log(
  `1. logged in, pathname=${await evalJs(`location.pathname`)} (onPos=${!!onPos}, welcomeDismissed=${welcomeGone})`
);

const added = await pos.addLineToCart();
console.log(`2. add to cart: ${added ? "OK" : "FAILED"}`);
if (!added) {
  const diag = await evalJs(`(() => ({
    href: location.href,
    readyState: document.readyState,
    htmlLen: document.documentElement.outerHTML.length,
    bodyLen: (document.body?.innerText || '').length,
    hasMain: !!document.querySelector('main'),
    cards: document.querySelectorAll('${POS.card}').length,
    gridEls: document.querySelectorAll('${POS.grid}').length,
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
  console.log(
    "card:",
    JSON.stringify(
      await evalJs(`(() => {
        const c = document.querySelector('${POS.card}');
        return c ? { ariaDisabled: c.getAttribute('aria-disabled'), text: (c.innerText || '').slice(0, 120) } : null;
      })()`)
    )
  );
  console.log("pay button:", JSON.stringify(await pos.payButton()));
  console.log("cart rail:", JSON.stringify(await pos.rail()));

  console.log("\n--- console errors ---");
  console.log(consoleErrors.length ? consoleErrors.slice(0, 10).map((e) => "· " + String(e).slice(0, 400)).join("\n") : "(none)");
  await explainScriptErrors();
  console.log("\n--- failed requests (with body) ---");
  await dumpFailures();
  await shot("checkout-ui-add-failed");
  process.exitCode = 1;
  await h.finish();
  process.exit(1);
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
  await h.finish();
  process.exit(1);
}
await waitFor(`document.querySelectorAll('${POS.payTile}').length === 4`, 10000);
await shot("checkout-ui-payment-modal");

// Cash tile + exact amount so the modal is in a valid state to submit.
await evalJs(`(() => {
  const cash = [...document.querySelectorAll('${POS.payTile}')].find(t => /cash/i.test(t.innerText || ''));
  if (cash) cash.click();
  return !!cash;
})()`);
await sleep(400);
const exactClicked = await evalJs(`(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find(d => /process payment/i.test(d.innerText || ''));
  const scope = dlg || document;
  // The chip label is "Exact · <amount>", not a bare "Exact" — an anchored
  // ^exact$ match could never hit it, so the click silently never happened.
  const exact = [...scope.querySelectorAll('button')].find(b => /^exact\b/i.test((b.innerText||'').trim()));
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
  // A checkout flow that never submitted IS a failure — this used to be
  // reported in prose and still exit 0, so a broken submit looked green.
  console.log("(no POST /api/pos/checkout was made — the client never submitted)");
  process.exitCode = 1;
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

const toasts = await evalJs(`(() => {
  const sel = '[role="status"],[role="alert"],[data-sonner-toast],.toast,[data-radix-toast]';
  return [...document.querySelectorAll(sel)].map(e => (e.innerText || '').trim()).filter(Boolean);
})()`);
console.log("\n--- toasts/alerts ---");
console.log(toasts && toasts.length ? toasts.map((t) => "· " + t).join("\n") : "(none)");

console.log("\n--- console errors ---");
console.log(consoleErrors.length ? consoleErrors.slice(0, 12).map((e) => "· " + String(e).slice(0, 300)).join("\n") : "(none)");

console.log("\n--- failed requests (with body) ---");
await dumpFailures();

/* ── cleanup: remove ONLY the orders this run created, restore their stock ──
   (Never match by date: that would delete real sales made while the test ran.) */
if (createdOrderIds.size === 0) {
  console.log("\nnothing to clean up (no order was created)");
}
try {
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
} catch (e) {
  console.log(`\ncleanup failed: ${e.message}`);
  process.exitCode = 1;
}

await h.finish();
