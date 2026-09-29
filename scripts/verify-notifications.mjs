/* NOTIFICATION VERIFICATION — real browser, real fetches.

   Companion to audit-neu-pages.mjs / scripts/verify-ui.mjs. It proves the
   header notification bell and the settings delivery log end to end,
   against a running app and a seeded database:

     1. /api/alerts answers with the bell's contract (inAppEnabled +
        generatedAt + the two lists + a summary);
     2. the bell opens from the header and renders a real READY state
        (scope row + either alert rows or the all-stocked state);
     3. when the alerts fetch is BLOCKED, the bell shows its ERROR state
        with a retry — it must never render "all stocked" on a failure
        (the bug this surface was rebuilt to remove), and the dashboard
        widget shows its own error EmptyState too;
     4. unblocking recovers the bell;
     5. /api/notifications/log answers with channels + log, and the
        settings page renders the Delivery log card.

   Read-only: it never mutates store settings. The failure path is
   produced by blocking the request over CDP, exactly like verify-ui.

   Usage:
     npm run build && npx next start -p 3311   # one shell
     BASE_URL=http://localhost:3311 node scripts/verify-notifications.mjs
   Or against a dev server:
     BASE_URL=http://localhost:3000 node scripts/verify-notifications.mjs

   Env:
     BASE_URL        default http://localhost:3000
     CHROME_PATH     browser binary
     HEADLESS_MODE   default --headless=new; some hosts drop CDP replies under
                     the new mode and are happier with --headless=old.
   Exits non-zero if any check fails.
*/
/* NOTE: headless Chrome on some Windows hosts intermittently drops CDP
   replies under load, which surfaces as "CDP timeout: Runtime.evaluate".
   The probe retries every evaluate and treats a missed Page.navigate reply as
   non-fatal, but a heavily loaded desktop can still exhaust those retries —
   run it against a built server / in CI for a stable signal. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CHROME = process.env.CHROME_PATH || {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
}[process.platform] || "/usr/bin/google-chrome";

const BASE = process.env.BASE_URL || "http://localhost:3000";
// Outside the project on purpose: a Chrome profile inside the watched tree
// makes `next dev` recompile in a loop and truncate .next, which 500s every
// API route. See the `.dbg-profile*` note in .gitignore.
const PROFILE = tmpdir() + "/codebuff-verify-notifications-profile";
// Some hosts drop CDP replies under the new headless mode; HEADLESS_MODE lets
// a run fall back (e.g. HEADLESS_MODE=--headless=old) without a code change.
const HEADLESS_MODE = process.env.HEADLESS_MODE || "--headless=new";

if (!existsSync(CHROME)) {
  console.error(`VERIFY ERROR: no Chrome at ${CHROME}\nSet CHROME_PATH to the browser binary.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, pass, detail) {
  if (!pass) failures++;
  console.log((pass ? "PASS  " : "FAIL  ") + name.padEnd(64) + (detail === undefined ? "" : " " + JSON.stringify(detail)));
}

let chrome = null;
let ws = null;
let msgId = 0;
const pending = new Map();

function send(method, params = {}, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }
    }, timeout);
  });
}

async function evalJs(expression, timeout) {
  const r = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    timeout
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}

/* Navigate and let the caller POLL for the result. Headless Chrome on some
   hosts drops or delays the Page.navigate reply while still loading the page,
   so a non-response here is not an error — waitFor() below is the source of
   truth about whether the page arrived. */
async function navigate(url) {
  try {
    await send("Page.navigate", { url }, 12000);
  } catch {
    /* the page may still be loading — polled next */
  }
  await sleep(500);
}

/* One-shot evaluation with retries — a single dropped CDP reply must not fail
   a check that would pass on the next attempt. */
/* A REAL mouse click over CDP at the element's centre. `el.click()` does not
   always reach React's delegated handler in headless Chrome; dispatching the
   input events the browser itself would is the faithful equivalent. */
async function clickExpr(expr) {
  const point = await evalRetry(`(() => {
    const el = ${expr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!point) return false;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  return true;
}

async function evalRetry(expression, tries = 4, timeout = 15000) {
  for (let i = 0; i < tries; i++) {
    try {
      return await evalJs(expression, timeout);
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(600);
    }
  }
}

async function waitFor(expression, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      // Short per-attempt budget: while a navigation is still committing, an
      // evaluate can hang with no execution context to answer it. Timing out
      // fast and retrying is what makes this robust against a slow dev compile.
      if (await evalJs(expression, 6000)) return true;
    } catch {
      /* navigating / no context yet — retry */
    }
    await sleep(300);
  }
  return false;
}

/*
 * Authenticate from INSIDE the page. Driving the login FORM in headless
 * Chrome is racy against hydration (and the form is covered by
 * scripts/verify-ui.mjs); doing the credentials exchange with a same-origin
 * fetch lets the browser own the CSRF + session cookies exactly as the app
 * does, then we navigate to the authenticated area.
 */
const LOGIN_IN_PAGE = `(async () => {
  const csrf = await (await fetch('/api/auth/csrf')).json();
  const r = await fetch('/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email: 'admin@elitepos.com',
      password: 'Admin@123',
      callbackUrl: '/dashboard',
    }),
  });
  return r.status;
})()`;

/* The bell is the header dropdown whose accessible name is about
   notifications. The theme toggle and account menu share the same
   aria-haspopup, so the NAME is the discriminator. */
const BELL = `[...document.querySelectorAll('header button[aria-haspopup="menu"]')].find((b) => /notification|اطلاعات/i.test(b.getAttribute('aria-label') || ''))`;
const PANEL = `document.querySelector('header [role="menu"]')`;

/* Structural classification of the open panel — locale-independent. */
const PANEL_STATE = `(() => {
  const p = ${PANEL};
  if (!p) return null;
  return {
    productLinks: p.querySelectorAll('a[role="menuitem"][href^="/products?search="]').length,
    redIcon: !!p.querySelector('svg.text-neu-ink-red'),
    greenIcon: !!p.querySelector('svg.text-neu-ink-green'),
    retry: [...p.querySelectorAll('button')].some((b) => /retry|دوبارہ/i.test(b.textContent || '')),
    scopeRow: !!(p.querySelector('span') && /(all warehouses|scoped to|تمام گاہ|تمام گودام|تک محدود)/i.test(p.textContent || '')),
    snippet: (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
  };
})()`;

(async () => {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const PORT = 9500 + Math.floor(Math.random() * 200);

  chrome = spawn(
    CHROME,
    [
      HEADLESS_MODE,
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      // Windows + headless can PAUSE a renderer it believes is occluded, which
      // stalls CDP. These keep the page running while the probe drives it.
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--mute-audio",
      ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      if (res.ok) target = await res.json();
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(500);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("could not open CDP tab");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
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

  // ── establish a real session from inside the page ──
  console.log("[step] authenticating…");
  await navigate(BASE + "/login");
  if (!(await waitFor(`!!document.querySelector('input[type=password]')`, 45000))) {
    throw new Error("the login page never loaded");
  }
  const loginStatus = await evalRetry(LOGIN_IN_PAGE);
  await navigate(BASE + "/dashboard");
  // The login page ALSO renders a <main>, so "main exists" is not proof of
  // the dashboard — the shell <header> is.
  const authed = await waitFor(
    `!location.pathname.startsWith('/login') && !!document.querySelector('header')`,
    45000
  );
  if (!authed) throw new Error(`could not reach the dashboard (login status ${loginStatus})`);
  await evalRetry(`localStorage.setItem("pos_welcome_seen_v1", "1")`);

  // ── 1. /api/alerts contract ──
  console.log("[step] checking /api/alerts contract…");
  const contract = await evalRetry(`(async () => {
    const r = await fetch("/api/alerts");
    const j = await r.json();
    return {
      status: r.status,
      alerts: Array.isArray(j.alerts),
      restockSoon: Array.isArray(j.restockSoon),
      inAppEnabled: typeof j.inAppEnabled,
      generatedAt: typeof j.generatedAt,
      summaryTotal: j.summary && typeof j.summary.total === "number",
    };
  })()`);
  check(
    "API: /api/alerts answers the bell contract",
    contract.status === 200 &&
      contract.alerts &&
      contract.restockSoon &&
      contract.inAppEnabled === "boolean" &&
      contract.generatedAt === "string" &&
      contract.summaryTotal,
    contract
  );

  // ── 2. the bell opens in a real READY state ──
  console.log("[step] opening the bell…");
  // Already on /dashboard from the auth step — no redundant navigation needed.
  check("bell: the header renders a notification trigger", await waitFor(`!!(${BELL})`));
  await clickExpr(BELL);
  const opened = await waitFor(`!!(${PANEL})`);
  check("bell: clicking it opens the panel", opened);
  if (!opened) {
    const dbg = await evalRetry(`(() => {
      const b = ${BELL};
      return {
        bell: !!b,
        expanded: b ? b.getAttribute('aria-expanded') : null,
        labels: [...document.querySelectorAll('header button[aria-haspopup="menu"]')].map((x) => x.getAttribute('aria-label')),
        menus: document.querySelectorAll('[role="menu"]').length,
        hydrated: !![...document.querySelectorAll('header button[aria-haspopup="menu"]')].find((x) => Object.keys(x).some((k) => k.startsWith('__reactFiber$'))),
      };
    })()`);
    console.log("      [debug] " + JSON.stringify(dbg));
  }

  const readyState = await waitFor(`(() => {
    const s = ${PANEL_STATE};
    return !!s && s.scopeRow && (s.productLinks > 0 || s.greenIcon);
  })()`, 20000);
  const rs = await evalRetry(PANEL_STATE);
  check("bell: READY renders the scope row and alerts-or-all-stocked", readyState, rs);

  // ── 3. a BLOCKED alerts fetch is an error, never 'all stocked' ──
  console.log("[step] blocking /api/alerts…");
  await send("Network.setBlockedURLs", { urls: ["*/api/alerts*"] });
  await navigate(BASE + "/dashboard");
  await waitFor(`location.pathname.startsWith('/dashboard') && !!document.querySelector('header')`, 30000);
  await clickExpr(BELL);
  const errorState = await waitFor(`(() => { const s = ${PANEL_STATE}; return !!s && s.redIcon && s.retry; })()`, 20000);
  const es = await evalRetry(PANEL_STATE);
  check("bell: a failed fetch shows the ERROR state + retry (not 'all stocked')", errorState, es);
  check("bell: the error state does NOT claim everything is stocked", !(es && es.greenIcon), es);

  // The dashboard widget must show its own error EmptyState under the same block.
  const widgetError = await waitFor(`!!document.querySelector('.neu-empty-icon-error')`, 15000);
  check("dashboard: the Restock widget shows the error EmptyState too", widgetError);

  // ── 4. unblocking recovers ──
  await send("Network.setBlockedURLs", { urls: [] });
  await navigate(BASE + "/dashboard");
  await waitFor(`location.pathname.startsWith('/dashboard') && !!document.querySelector('header')`, 30000);
  await waitFor(`!!(${BELL})`);
  await clickExpr(BELL);
  await waitFor(`!!(${PANEL})`);
  const recovered = await waitFor(`(() => {
    const s = ${PANEL_STATE};
    return !!s && !s.redIcon && s.scopeRow && (s.productLinks > 0 || s.greenIcon);
  })()`, 20000);
  check("bell: unblocking recovers to the READY state", recovered);

  // ── 5. delivery log API + settings card ──
  console.log("[step] checking the delivery log…");
  const logContract = await evalRetry(`(async () => {
    const r = await fetch("/api/notifications/log?limit=25");
    const j = await r.json();
    return {
      status: r.status,
      log: Array.isArray(j.log),
      channels: j.channels && typeof j.channels.webhook === "boolean" && typeof j.channels.email === "boolean" && typeof j.channels.inApp === "boolean",
      cooldown: typeof j.cooldownHours === "number",
      warehouseNames: Array.isArray(j.log) && j.log.every((e) => "warehouseName" in e),
    };
  })()`);
  check(
    "API: /api/notifications/log answers channels + enriched log",
    logContract.status === 200 && logContract.log && logContract.channels && logContract.cooldown && logContract.warehouseNames,
    logContract
  );

  await navigate(BASE + "/settings");
  await waitFor(`location.pathname.startsWith('/settings') && !!document.querySelector('main')`, 30000);
  const cardShown = await waitFor(`/delivery log|ترسیل کا لاگ/i.test(document.body.textContent || '')`, 20000);
  check("settings: the Delivery log card renders", cardShown);
  const cardError = await evalRetry(`!!document.querySelector('.neu-empty-icon-error')`);
  check("settings: the Delivery log card loaded without an error state", cardError === false);

  console.log("\n" + (failures === 0 ? "ALL NOTIFICATION CHECKS PASSED" : failures + " CHECK(S) FAILED"));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error("VERIFY ERROR:", err?.message || err);
  process.exitCode = 1;
}).finally(() => {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    chrome?.kill();
  } catch {
    /* ignore */
  }
  // Chrome can still hold Crashpad files for a moment after kill(); a locked
  // temp profile must not turn a passing run into a crash.
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(PROFILE, { recursive: true, force: true });
      break;
    } catch {
      /* retry */
    }
  }
});
