/* Shared headless-Chrome (CDP) harness for the audit-*.mjs scripts.

   Every audit used to carry its own copy of the same plumbing: spawn Chrome,
   open a tab via /json/new, connect the socket, Runtime/Page/Log enable,
   evalJs / waitFor / nav / text / shot / setViewport / login, a `results`
   array and a `check()` that prints PASS/FAIL. Nine copies of that meant nine
   places to fix a bug in it — and the POS audits additionally each grew their
   own version of "add a line to the cart".

   Two things this harness fixes rather than re-implements:

   1. The Chrome profile lives in `tmpdir()`, NOT in the project. A profile
      inside the watched tree makes `next dev` recompile in a loop and truncate
      .next, which 500s every API route. audit-checkout-ui.mjs had worked this
      out and documented it; every other audit still wrote its profile to
      `.audit-chrome-profile*` in the repo root, which is where the spurious
      cold-start 500s came from.

   2. A 5xx is now a FAILURE, not a line in the log. `summary()` reports every
      server error it saw and marks the run failed, so a route that starts
      returning 500 can never hide behind a green score again. `warmup()`
      absorbs the one genuinely benign case — the on-demand compile of a route
      that `next dev` has not built yet — by polling it into existence before
      the phases run.

   Usage:
     import { createHarness, sleep, POS } from "./audit-harness.mjs";
     const h = await createHarness({ name: "pos", loginPath: "/pos" });
     const { check, evalJs, waitFor, nav, shot } = h;
     const ok = await h.login();
     check("browser login succeeds", ok === true);
     ...
     await h.finish();

   The harness never calls process.exit(): it sets `process.exitCode` and lets
   the node-side cleanup in `finish()` run first.
*/
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CHROME_PATH =
  process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
export const DEFAULT_BASE = process.env.BASE || "http://localhost:3000";
export const SHOTS_DIR = process.cwd() + "/.audit-shots";
export const CREDENTIALS = {
  email: process.env.AUDIT_EMAIL || "admin@elitepos.com",
  password: process.env.AUDIT_PASSWORD || "Admin@123",
};

/* ── Selectors the register audits share ──
   `.pos-cart-rail` is not cosmetic: the dashboard shell renders its own nav
   rail and an off-canvas drawer as <aside> elements AHEAD of the register's
   cart panel, so `document.querySelector('aside')` measures the nav rail
   (72px below `lg`, 260px above) and never the cart. Scope to this hook. */
export const POS = {
  grid: ".pos-grid",
  card: `.pos-grid > [role="button"]`,
  cartRail: ".pos-cart-rail",
  payTile: ".pos-pay-tile",
  payTileActive: ".pos-pay-tile-active",
  cashQuick: ".pos-cash-quick",
  cashQuickBtn: ".pos-cash-quick-btn",
  segmented: ".pos-segmented",
  segmentedBtn: ".pos-segmented-btn",
};

/* The unit-quantity and payment dialogs are both titled from the i18n
   dictionary, so the heading text is a stable handle. */
const QUANTITY_HEADING = "quantity";
const ADD_TO_ORDER = /add to order/i;
const PAY_BUTTON = /^pay/i;

/**
 * Fail the run if the browser logged a 5xx.
 *
 * For audits that still carry their own CDP body (they have not been moved
 * onto createHarness yet) this is the drop-in equivalent of the harness's own
 * server-error gate: the browser reports every failed resource load through
 * Log.entryAdded, which those scripts already collect into `consoleErrors`.
 * Previously a 500 was one line in a "console errors:" dump and the run still
 * exited 0.
 *
 * @param {string[]} consoleErrors collected by the calling script
 * @param {{ name?: string }} [opts]
 * @returns {number} how many 5xx were found
 */
export function assertNoServerErrors(consoleErrors, { name = "audit" } = {}) {
  const hits = consoleErrors.filter((e) => /status of 5\d\d|\b5\d\d \(Internal Server Error\)|Server Error/i.test(String(e)));
  if (!hits.length) return 0;
  console.log(`\nserver errors (${hits.length}) in ${name} — counted as failures:`);
  for (const e of [...new Set(hits)].slice(0, 10)) console.log(`  · ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
  return hits.length;
}

/**
 * Build a CDP harness: spawn Chrome, attach to a fresh tab, and return the
 * helpers every audit needs.
 */
export async function createHarness(options = {}) {
  const {
    name = "audit",
    base = DEFAULT_BASE,
    loginPath = "/dashboard",
    loginRetries = 3,
    navReadyExpr = "!!document.querySelector('main')",
    navAttempts = 2,
    waitForTimeout = 15000,
    waitForInterval = 300,
    sendTimeoutMs = 45000,
    viewport = { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
    warmupPaths = [],
    /* Enable the Debugger domain — needed only by audits that resolve a
       bundle SyntaxError back to its source via Debugger.getScriptSource(). */
    debugger: enableDebugger = false,
    failOnServerError = true,
    profileDir = `${tmpdir()}/codebuff-audit-${name}`,
    chromePath = CHROME_PATH,
    windowSize = "1440,900",
  } = options;

  mkdirSync(SHOTS_DIR, { recursive: true });
  rmSync(profileDir, { recursive: true, force: true });

  const results = [];
  const consoleErrors = [];
  const pageErrors = [];
  /** Every ≥500 response seen after warmup: { url, status }. */
  const serverErrors = [];
  /** Every response seen before `warmup()` finished — compiled on demand. */
  const warmupResponses = [];
  let warmedUp = false;

  const pending = new Map();
  const handlers = new Map();
  let msgId = 0;
  let ws = null;
  let chrome = null;
  let closed = false;

  function on(method, fn) {
    if (!handlers.has(method)) handlers.set(method, new Set());
    handlers.get(method).add(fn);
    return () => handlers.get(method)?.delete(fn);
  }

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!ws) return reject(new Error("harness: not connected"));
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, sendTimeoutMs);
    });
  }

  /**
   * Evaluate in the page. Returns `undefined` when the expression throws —
   * an object sentinel would read as truthy and make `waitFor` succeed on an
   * error. The exception text is kept in `pageErrors` for the report.
   */
  async function evalJs(expr) {
    let r;
    try {
      r = await send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (e) {
      pageErrors.push(`eval transport: ${e.message}`);
      return undefined;
    }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      pageErrors.push(`${d.text} ${d.exception?.description ?? ""}`.trim());
      return undefined;
    }
    return r.result?.value;
  }

  async function waitFor(expr, timeout = waitForTimeout, interval = waitForInterval) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = await evalJs(expr);
      if (v) return v;
      await sleep(interval);
    }
    const v = await evalJs(expr);
    return v || null;
  }

  async function nav(path, { readyExpr = navReadyExpr, attempts = navAttempts } = {}) {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await send("Page.navigate", { url: base + path });
      await waitFor("document.readyState === 'complete'", 20000);
      last = await waitFor(readyExpr, 25000);
      if (last) return last;
      await sleep(1200);
    }
    return last;
  }

  const text = () => evalJs("document.body.innerText");

  async function shot(filename) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r?.data) {
      writeFileSync(`${SHOTS_DIR}/${filename}.png`, Buffer.from(r.data, "base64"));
      console.log(`  📸 ${SHOTS_DIR}/${filename}.png`);
    }
  }

  async function setViewport(width, height, { mobile = width < 768, deviceScaleFactor = 1 } = {}) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
    await sleep(500); // let reflow / media queries settle
  }

  /* ── input helpers ── */
  const click = (selector) =>
    evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`
    );

  const clickText = (label, rootSel = "body") =>
    evalJs(`(() => {
      const root = document.querySelector(${JSON.stringify(rootSel)}) || document;
      const els = [...root.querySelectorAll("button, a, span, td, th, tr, div, label, option, [role=menuitem]")];
      const want = ${JSON.stringify(label)};
      const el = els.find(e => (e.innerText || "").trim() === want)
        || els.find(e => (e.innerText || "").includes(want) && (e.innerText || "").length < 120);
      if (!el) return false;
      el.click();
      return true;
    })()`);

  const typeText = (value) => send("Input.insertText", { text: value });

  const key = async (k) => {
    const vk = k === "Enter" ? 13 : 0;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk });
  };

  /** Focus `selExpr`, select all, and type — for React-controlled fields. */
  async function selectAllAndType(selExpr, value) {
    const focused = await evalJs(`(() => { const el = ${selExpr}; if (!el) return false; el.focus(); return true; })()`);
    if (!focused) return false;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await typeText(value);
    return true;
  }

  /**
   * Fetch from inside the page so cookies + Origin come from the browser.
   * Retries transport failures and 5xx (a route may still be compiling).
   */
  async function pageFetch(path, opts = {}) {
    let out = { status: 0, body: null };
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await evalJs(`(async () => {
        try {
          const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify(opts)});
          let body = null;
          try { body = await r.json(); } catch { body = null; }
          return { status: r.status, body };
        } catch (e) {
          return { status: 0, body: null, transport: String(e) };
        }
      })()`);
      if (res && res.status && res.status < 500) return res;
      if (res) out = res;
      await sleep(800 * (attempt + 1));
    }
    return out;
  }

  function check(name, cond, extra = "") {
    results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
    console.log(results[results.length - 1]);
    if (!cond) process.exitCode = 1;
    return !!cond;
  }

  /**
   * Sign in through the real form. Idempotent: if the session cookie is still
   * good, navigating to `loginPath` lands authenticated and nothing is typed.
   */
  async function login(path = loginPath) {
    const landed = path.startsWith("/") ? path : `/${path}`;
    for (let attempt = 0; attempt < loginRetries; attempt++) {
      await nav(landed);
      let authed = await waitFor(`location.pathname.startsWith(${JSON.stringify(landed)})`, 20000);
      if (!authed) {
        await nav("/login");
        const ready = await waitFor(
          `!!document.querySelector('input[type=email]') && !!document.querySelector('input[type=password]')`,
          25000
        );
        if (!ready) continue;
        await selectAllAndType("document.querySelector('input[type=email]')", CREDENTIALS.email);
        await selectAllAndType("document.querySelector('input[type=password]')", CREDENTIALS.password);
        await clickText("Sign in") || (await clickText("Login")) || (await clickText("Log in"));
        authed = await waitFor(
          `location.pathname.startsWith(${JSON.stringify(landed)}) || location.pathname.startsWith('/dashboard')`,
          30000
        );
      }
      if (authed) return true;
    }
    return false;
  }

  /**
   * Poll routes until they answer < 500. In `next dev` the first hit on a
   * route triggers an on-demand compile that can 500; that is a build step,
   * not a defect, so it is absorbed here and anything after it is a failure.
   */
  async function warmup(paths = warmupPaths, attempts = 6) {
    for (const p of paths) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const r = await pageFetch(p);
        if (r.status && r.status < 500) break;
        await sleep(700 * (attempt + 1));
      }
    }
    warmedUp = true;
  }

  /* ── POS driver ──
     One implementation of "put a line in the cart", shared by the register
     audits instead of each carrying its own. Two rules it encodes:

       • Prefer a WHOLE-UNIT product. A weight/loose line only lands after its
         unit-quantity dialog is filled in, so picking the first sellable card
         at random makes the test depend on catalog ordering.
       • The unit-quantity dialog has two modes: "by quantity" is already valid
         on open (quantity defaults to 1), but "by amount" opens empty and
         keeps its confirm button disabled until an amount is typed. React
         ignores a plain `.value` assignment, so the field has to be driven
         through the native setter to make onChange fire. */
  const pos = {
    CARD: POS.card,
    RAIL: POS.cartRail,
    cardCountExpr: `document.querySelectorAll('${POS.card}').length`,
    cardCount: () => evalJs(`document.querySelectorAll('${POS.card}').length`),

    /** Box + identity of the register's cart rail. */
    rail: () =>
      evalJs(`(() => {
        const el = document.querySelector('${POS.cartRail}');
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        return {
          found: true,
          display: getComputedStyle(el).display,
          width: Math.round(r.width),
          right: Math.round(r.right),
          visible: r.width > 100 && r.right <= window.innerWidth + 2,
        };
      })()`),

    railDisplay: () =>
      evalJs(`(() => {
        const el = document.querySelector('${POS.cartRail}');
        return el ? { display: getComputedStyle(el).display } : { display: 'none' };
      })()`),

    /** The enabled Pay button, or null. */
    payButton: () =>
      evalJs(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => ${PAY_BUTTON}.test((x.innerText || '').trim()));
        return b ? { found: true, disabled: b.disabled, text: (b.innerText || '').trim() } : { found: false };
      })()`),

    payEnabled: () =>
      waitFor(
        `(() => {
          const b = [...document.querySelectorAll('button')].find(x => ${PAY_BUTTON}.test((x.innerText || '').trim()));
          return !!(b && !b.disabled);
        })()`,
        6000
      ),

    /** Click a sellable product card, preferring a whole-unit one. */
    addFirstCard: () =>
      evalJs(`(() => {
        const all = [...document.querySelectorAll('${POS.card}')];
        const sellable = all.filter(c => c.getAttribute('aria-disabled') !== 'true');
        // Plain string probes on purpose — backslashes are eaten by this template.
        const wholeUnit = sellable.filter(c => {
          const t = (c.innerText || '').toLowerCase();
          return !(t.indexOf('/ l') >= 0 || t.indexOf('/ kg') >= 0 || t.indexOf('/ g') >= 0
            || t.indexOf('/ ml') >= 0 || t.indexOf('per ') >= 0);
        });
        const card = wholeUnit[0] || sellable[0] || all[0];
        if (!card) return false;
        card.click();
        return true;
      })()`),

    /**
     * Fill the unit-quantity dialog's field when it opened in "by amount" mode.
     * Separate from the click because the re-render that clears `disabled`
     * does not happen synchronously.
     */
    fillQtyDialog: () =>
      evalJs(`(() => {
        const h = [...document.querySelectorAll('h2')]
          .find(x => new RegExp('^${QUANTITY_HEADING}$', 'i').test((x.textContent || '').trim()));
        if (!h) return false;
        const panel = h.closest('[role="dialog"]') || h.parentElement?.parentElement;
        if (!panel) return false;
        const ok = [...panel.querySelectorAll('button')].find(b => ${ADD_TO_ORDER}.test(b.innerText || ''));
        if (!ok || !ok.disabled) return false;
        const num = [...panel.querySelectorAll('input[type="number"]')]
          .find(i => !i.value || Number(i.value) <= 0);
        if (!num) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(num, '1');
        num.dispatchEvent(new Event('input', { bubbles: true }));
        num.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`),

    /** Commit the unit-quantity dialog so the line reaches the cart. */
    confirmQtyDialog: () =>
      evalJs(`(() => {
        const h = [...document.querySelectorAll('h2')]
          .find(x => new RegExp('^${QUANTITY_HEADING}$', 'i').test((x.textContent || '').trim()));
        if (!h) return false;
        const panel = h.closest('[role="dialog"]') || h.parentElement?.parentElement;
        if (!panel) return false;
        const ok = [...panel.querySelectorAll('button')].find(b => ${ADD_TO_ORDER}.test(b.innerText || ''));
        if (ok && !ok.disabled) { ok.click(); return true; }
        return false;
      })()`),

    /** Add one line and wait for Pay to become enabled. */
    async addLineToCart(attempts = 8) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        // The grid is the slowest thing on the register page; wait for it
        // rather than burning an attempt on an unpainted shell.
        const cards = await waitFor(`document.querySelectorAll('${POS.card}').length > 0`, 10000, 400);
        if (!cards) continue;
        await pos.addFirstCard();
        await sleep(500);
        await pos.fillQtyDialog();
        await sleep(400);
        await pos.confirmQtyDialog();
        if (await pos.payEnabled()) return true;
      }
      return false;
    },
  };

  /* ── report ── */
  function summary({ print = true } = {}) {
    const passed = results.filter((r) => r.startsWith("PASS")).length;
    const failed = results.filter((r) => r.startsWith("FAIL")).length;

    if (print) {
      if (pageErrors.length) {
        console.log("\npage errors:");
        for (const e of pageErrors.slice(0, 8)) console.log(`  · ${String(e).slice(0, 300)}`);
      }
      if (consoleErrors.length) {
        console.log("\nconsole errors:");
        for (const e of consoleErrors.slice(0, 8)) console.log(`  · ${String(e).slice(0, 300)}`);
      }
      /* A 5xx is a defect, not noise. The old scripts printed "console errors:"
         and carried on, which is exactly how a broken route stayed invisible.
         Anything during warmup was an on-demand compile and is reported
         separately as informational. */
      if (serverErrors.length) {
        console.log(
          `\nserver errors (${serverErrors.length}) — ${failOnServerError ? "counted as failures" : "informational"}:`
        );
        for (const e of serverErrors.slice(0, 10)) console.log(`  · HTTP ${e.status} ${e.url}`);
        if (failOnServerError) process.exitCode = 1;
      } else if (warmupResponses.length) {
        console.log(
          `\n(on-demand compile 5xx absorbed during warmup: ${warmupResponses.length} — route built on first hit)`
        );
      }
      // Diagnostic scripts (audit-checkout-ui) assert with their own numbered
      // steps and register no checks at all — don't print an empty tally.
      if (results.length) console.log(`\n═══ ${passed} PASS / ${failed} FAIL ═══`);
    }
    return { passed, failed };
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      /* socket already gone */
    }
    try {
      chrome?.kill();
    } catch {
      /* process already gone */
    }
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(800);
      }
    }
  }

  /** summary() + close(). The normal end of an audit's main(). */
  async function finish(opts) {
    const out = summary(opts);
    await close();
    return out;
  }

  /* ── connect ── */
  const PORT = 9333 + Math.floor(Math.random() * 400);
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      // Outside the project: see the header note.
      `--user-data-dir=${profileDir}`,
      `--window-size=${windowSize}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  await sleep(2500);

  let tab = null;
  for (let i = 0; i < 20 && !tab; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      tab = await res.json();
    } catch {
      await sleep(1000);
    }
  }
  if (!tab?.webSocketDebuggerUrl) {
    await close();
    throw new Error("could not open a CDP tab");
  }

  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
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
    if (!msg.method) return;

    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(`UNCAUGHT: ${d.exception?.description ?? d.text} @ ${d.url || d.scriptId}:${d.lineNumber}`);
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErrors.push(msg.params.entry.text);
    } else if (msg.method === "Network.responseReceived") {
      const { response } = msg.params;
      if (response?.status >= 500) {
        const entry = { url: response.url, status: response.status };
        if (warmedUp) serverErrors.push(entry);
        else warmupResponses.push(entry);
      }
    }

    const subs = handlers.get(msg.method);
    if (subs) for (const fn of subs) fn(msg.params);
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("Network.enable");
  if (enableDebugger) await send("Debugger.enable");
  if (viewport) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      mobile: viewport.mobile ?? false,
    });
  }
  // The first page load is the usual cold-start victim, and so is whichever
  // API route the audit leans on first: get them built before anything is
  // asserted, so a 5xx after this point is unambiguously a defect.
  await warmup(["/api/auth/session", ...warmupPaths], 5);

  return {
    // connection
    send,
    on,
    base,
    creds: CREDENTIALS,
    // page
    evalJs,
    waitFor,
    nav,
    text,
    shot,
    setViewport,
    // input
    click,
    clickText,
    typeText,
    key,
    selectAllAndType,
    // app
    login,
    pageFetch,
    warmup,
    pos,
    // reporting
    check,
    results,
    consoleErrors,
    pageErrors,
    serverErrors,
    summary,
    finish,
    close,
    get failOnServerError() {
      return failOnServerError;
    },
    setWarmedUp: (v = true) => {
      warmedUp = v;
    },
  };
}
