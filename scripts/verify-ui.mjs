/* UI VERIFICATION — real browser, real fetches.

   Companion to audit-neu-pages.mjs. That one scan-checks colours and
   states; this one asserts the empty/error/validation vocabulary end
   to end:

     1. an empty POS cart renders the shared EmptyState;
     2. a POS search with no matches renders the shared EmptyState with
        the query echoed back;
     3. a FAILED product fetch renders the error EmptyState + a Retry
        button (not an empty-cart lie), and clicking Retry recovers;
     4. write endpoints answer a rejection FIELD-BY-FIELD, which is what
        lets the forms underline the exact input instead of toasting an
        opaque blob.

   Step 3 blocks `/api/pos/search` over CDP, so the failure is real.

   Usage:
     npm run build && npx next start -p 3311   # one shell
     npm run verify:ui                         # another
   Env: BASE_URL (default http://localhost:3311), CHROME_PATH.
   Exits non-zero if any check fails.
*/
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CHROME = process.env.CHROME_PATH || {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
}[process.platform] || "/usr/bin/google-chrome";

const BASE = process.env.BASE_URL || "http://localhost:3311";
// Outside the project on purpose: a Chrome profile inside the watched tree
// makes `next dev` recompile in a loop and truncate .next, which 500s every
// API route. See the `.dbg-profile*` note in .gitignore.
const PROFILE = tmpdir() + "/codebuff-verify-ui-profile";

const SEARCH_PLACEHOLDER = "Scan barcode or search product...";
const SEARCH_INPUT = `input[placeholder=${JSON.stringify(SEARCH_PLACEHOLDER)}]`;

if (!existsSync(CHROME)) {
  console.error(`VERIFY ERROR: no Chrome at ${CHROME}\nSet CHROME_PATH to the browser binary.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, pass, detail) {
  if (!pass) failures++;
  console.log((pass ? "PASS  " : "FAIL  ") + name.padEnd(60) + (detail === undefined ? "" : " " + JSON.stringify(detail)));
}

let chrome = null;
let ws = null;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout: " + method)); }
    }, 30000);
  });
}

async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}

async function waitFor(expression, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evalJs(expression)) return true; } catch { /* navigating */ }
    await sleep(250);
  }
  return false;
}

/* Fill through React's own value setter — the CDP typing path is racy
   against hydration and silently types nothing when it loses. */
function fillScript(sel, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const proto = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  })()`;
}

(async () => {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const PORT = 9700 + Math.floor(Math.random() * 200);

  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      if (res.ok) target = await res.json();
    } catch { /* not up yet */ }
    if (!target) await sleep(500);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("could not open CDP tab");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  // ── log in through the UI (cookies + Origin handled by the app) ──
  // A dev server compiles /login (and the /dashboard it redirects to) on
  // first hit, which can stream for tens of seconds. Filling the form the
  // instant the inputs hydrate races that stream and the submit is lost —
  // so wait for the document to settle first, and give the whole login a
  // second attempt if the first one is swallowed by a late re-render.
  const loginOnce = async () => {
    await send("Page.navigate", { url: BASE + "/login" });
    const ready = await waitFor(`(() => {
      const f = document.querySelectorAll('input[type=email], input[type=password]');
      return f.length >= 2 && [...f].every((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$')));
    })()`);
    if (!ready) return "the login form never hydrated";
    // Let the page finish streaming before driving the form.
    await waitFor(`document.readyState === 'complete'`, 30000);
    await sleep(1000);
    await evalJs(fillScript("input[type=email]", "admin@elitepos.com"));
    await evalJs(fillScript("input[type=password]", "Admin@123"));
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /sign in|log in/i.test(x.textContent || ''));
      if (b) b.click();
      return !!b;
    })()`);
    // A dev server compiles the redirect target (/dashboard) on first hit,
    // which can take 30s+ — give the redirect real headroom.
    if (await waitFor(`!location.pathname.startsWith('/login')`, 60000)) return null;
    return "still on /login after submit";
  };
  const failure = await loginOnce();
  if (failure) {
    const second = await loginOnce();
    if (second) throw new Error("could not log in at " + BASE + " — " + second);
  }

  // Suppress the one-time welcome modal so it cannot cover the probes.
  await evalJs(`localStorage.setItem("pos_welcome_seen_v1", "1")`);

  const titleText = `[...document.querySelectorAll('.neu-empty-title')].map((n) => n.textContent.trim())`;

  // ── 1. empty cart uses the shared EmptyState ──
  await send("Page.navigate", { url: BASE + "/pos" });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('main')`);
  const cartEmptyReady = await waitFor(`document.querySelectorAll('.neu-empty-title').length > 0`);
  check("POS: the empty cart renders the shared EmptyState", cartEmptyReady);
  const titles = await evalJs(titleText);
  check("POS: the cart empty copy is 'Ready to ring up a sale?'",
        Array.isArray(titles) && titles.some((s) => /ready to ring up a sale/i.test(s)), titles);

  // ── 2. a no-match search uses the shared EmptyState ──
  await evalJs(fillScript(SEARCH_INPUT, "zzz-no-such-product-zzz"));
  const searchEmpty = await waitFor(
    `[...document.querySelectorAll('.neu-empty-title')].some((n) => /zzz-no-such-product-zzz/i.test(n.textContent || ''))`
  );
  check("POS: a no-match search renders the shared EmptyState with the query", searchEmpty);

  // Clear the search so the grid returns before the failure probe.
  await evalJs(fillScript(SEARCH_INPUT, ""));
  await sleep(600);

  // ── 3. a failed fetch renders the ERROR EmptyState + a working Retry ──
  await send("Network.setBlockedURLs", { urls: ["*/api/pos/search*"] });
  await send("Page.navigate", { url: BASE + "/pos" });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('main')`);
  const errorShown = await waitFor(`!!document.querySelector('.neu-empty-icon-error')`, 20000);
  check("POS: a failed product fetch renders the error EmptyState (not 'no products')", errorShown);
  const retryLabel = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /retry/i.test(x.textContent || ''));
    return b ? b.textContent.trim() : null;
  })()`);
  check("POS: the error state offers a Retry button", retryLabel !== null, retryLabel);

  // Recover: unblock and press Retry.
  await send("Network.setBlockedURLs", { urls: [] });
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /retry/i.test(x.textContent || ''));
    if (b) b.click();
    return !!b;
  })()`);
  const recovered = await waitFor(
    `!document.querySelector('.neu-empty-icon-error') && !!document.querySelector('.pos-grid')`,
    20000
  );
  check("POS: Retry recovers the grid and clears the error", recovered);

  // ── 4. write endpoints answer rejections field-by-field ──
  const apiProbe = (path, body) =>
    evalJs(`(async () => {
      const r = await fetch(${JSON.stringify(path)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(${JSON.stringify(body)}),
      });
      let j = null;
      try { j = await r.json(); } catch { j = null; }
      return { status: r.status, error: j && j.error };
    })()`);

  const dupEmail = await apiProbe("/api/users", {
    name: "Verification Probe",
    email: "admin@elitepos.com", // seeded — guarantees the 409 branch
    password: "Password1",
  });
  check("API: a duplicate user email is field-keyed",
        dupEmail.status === 409 && Array.isArray(dupEmail.error?.email), dupEmail);

  const missingName = await apiProbe("/api/users", {
    name: "",
    email: "verification-probe@example.com",
    password: "Password1",
  });
  check("API: a missing user name is field-keyed",
        missingName.status === 400 && Array.isArray(missingName.error?.name), missingName);

  const supplierNoName = await apiProbe("/api/suppliers", { name: "" });
  check("API: a missing supplier name is field-keyed",
        supplierNoName.status === 400 && Array.isArray(supplierNoName.error?.name), supplierNoName);

  const poEmpty = await apiProbe("/api/purchase-orders", {});
  check("API: a PO with no supplier/warehouse/items names each field",
        poEmpty.status === 400 &&
        Array.isArray(poEmpty.error?.supplierId) &&
        Array.isArray(poEmpty.error?.warehouseId) &&
        Array.isArray(poEmpty.error?.items), poEmpty);

  const poBadSupplier = await apiProbe("/api/purchase-orders", {
    supplierId: "verification-probe-missing",
    warehouseId: "verification-probe-missing",
    items: [{ productId: "x", productName: "Probe", sku: "PROBE", quantity: 1, unitCost: 1 }],
  });
  check("API: an unknown PO supplier is field-keyed",
        poBadSupplier.status === 404 && Array.isArray(poBadSupplier.error?.supplierId), poBadSupplier);

  console.log(`\n${failures === 0 ? "ALL UI CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error("VERIFY ERROR:", err.message);
  process.exitCode = 1;
}).finally(() => {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill(); } catch { /* ignore */ }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
});
