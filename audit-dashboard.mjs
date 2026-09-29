/* Dashboard visual + functional QA (i18n templates, currency sync, dark mode,
   RTL, mobile). CDP via scripts/audit-harness.mjs — see that file for why the
   Chrome profile lives outside the project and why a 5xx fails the run.

   BASE is `localhost` (matching AUTH_URL) so NextAuth accepts the Origin
   header the CSRF-protected settings PUT is required to send.

   Usage: node audit-dashboard.mjs   (expects dev server on localhost:3000) */
import { createHarness, sleep } from "./scripts/audit-harness.mjs";

const h = await createHarness({
  name: "dashboard",
  base: "http://localhost:3000",
  loginPath: "/dashboard",
  warmupPaths: ["/api/settings/currency", "/api/dashboard", "/api/settings"],
});

const { check, evalJs, waitFor, nav, text, shot, send, clickText, pageFetch } = h;

/* ─────────────── PHASES ─────────────── */

async function phaseCurrencyEndpoint() {
  console.log("\n── PHASE: /api/settings/currency ──");
  const r = await pageFetch("/api/settings/currency");
  const d = r.body || {};
  check(
    "currency endpoint answers for a signed-in session",
    r.status === 200 && /^[A-Z]{3}$/.test(d.currency || ""),
    `${r.status} ${d.currency}`
  );
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
  check(
    "no raw i18n keys leak into the UI",
    !(await text()).includes("dashboard.topCustomers") && !(await text()).includes("dashboard.orderStatusBreakdown")
  );
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
    const bareVerb = /^(sold|refunded|adjusted|transferred|created|updated|deleted)$/m.test(activitySentence);
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
  await waitFor(
    `document.body.innerText.includes("Today's Revenue") || document.body.innerText.includes("Quick Actions")`,
    15000
  );
  await sleep(800);
  const overflow = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
  check("no horizontal page overflow on mobile", overflow <= 1, `overflow=${overflow}px`);
  await shot("dashboard-mobile");
  await send("Emulation.clearDeviceMetricsOverride");
}

/* ─────────────── MAIN ─────────────── */
const loggedIn = await h.login();
check("browser login succeeds", !!loggedIn);
if (!loggedIn) {
  console.log("ABORT: could not log in via UI");
  await h.finish();
  process.exit(1);
}
const apiAuthed = loggedIn; // API calls run in-page with the browser session
check("browser session ready for in-page API calls", !!apiAuthed);

try {
  const originalCurrency = await phaseCurrencyEndpoint();
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

await h.finish();
