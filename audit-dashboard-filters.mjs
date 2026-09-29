/* Dashboard date-range + granularity QA.
   Verifies:
     • /api/dashboard range semantics (today default, 7d daily, 30d monthly)
     • trend buckets sum to rangeRevenue, comparison sums to the total
     • scoped + ranged queries stay ≤ unscoped
     • the in-page range presets relabel, re-render and persist

   CDP plumbing comes from scripts/audit-harness.mjs — see that file for why
   the Chrome profile lives outside the project and why a 5xx fails the run.

   Usage: node audit-dashboard-filters.mjs  (dev server on localhost:3000) */
import { createHarness, sleep } from "./scripts/audit-harness.mjs";

const h = await createHarness({
  name: "dashboard-filters",
  loginPath: "/dashboard",
  navReadyExpr: "!!document.querySelector('header') && !!document.querySelector('main')",
  warmupPaths: ["/api/dashboard", "/api/warehouses"],
});

const { check, evalJs, waitFor, nav, text, shot, pageFetch } = h;

const nums = (s) => (s.match(/\d[\d,]*(\.\d+)?/g) || []).join(",");

/* Click a preset button inside the range group.

   NOT `document.querySelector('div[role="group"][aria-label]')`: the header's
   live clock is also a `div[role="group"]` with an aria-label, and it sits
   ahead of the page content in the DOM — so the old selector matched the clock
   and this helper returned false on every call (7 of this audit's checks failed
   on it). Pick the group that actually holds the preset buttons instead. */
async function clickRangePreset(label) {
  return evalJs(`(() => {
    const PRESETS = ['today', 'last 7 days', 'last 30 days', 'this month'];
    const groups = [...document.querySelectorAll('div[role="group"][aria-label]')];
    const group = groups.find(g => [...g.querySelectorAll('button')].some(b =>
      PRESETS.includes((b.innerText || '').trim().toLowerCase())));
    if (!group) return false;
    const btn = [...group.querySelectorAll('button')].find(b => (b.innerText || '').trim() === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
}

/* ─────────────── PHASES ─────────────── */

function dayStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function phaseRangeApi() {
  console.log("\n── PHASE: range API semantics ──");
  const today = dayStr(0);

  const dflt = await pageFetch("/api/dashboard");
  check("default dashboard answers", dflt.status === 200 && !!dflt.body);
  check(
    "default range = today (rangeMeta echo)",
    dflt.body?.rangeMeta?.from === today && dflt.body?.rangeMeta?.to === today,
    `${dflt.body?.rangeMeta?.from}..${dflt.body?.rangeMeta?.to}`
  );
  check("default granularity = daily", dflt.body?.rangeMeta?.granularity === "daily");
  check(
    "trend series has one bucket for today",
    (dflt.body?.weekTrend?.length ?? 0) === 1 && dflt.body?.trendPeriod === "day",
    `${dflt.body?.weekTrend?.length} bucket(s)`
  );

  const from7 = dayStr(-6);
  const d7 = await pageFetch(`/api/dashboard?from=${from7}&to=${today}`);
  const sum7 = (d7.body?.weekTrend ?? []).reduce((s, b) => s + b.revenue, 0);
  check("7d range answers with 7 daily buckets", (d7.body?.weekTrend?.length ?? 0) === 7);
  check(
    "7d trend buckets sum ≈ rangeRevenue",
    Math.abs(sum7 - (d7.body?.rangeRevenue ?? -1)) < 1,
    `${sum7} vs ${d7.body?.rangeRevenue}`
  );

  const from30 = dayStr(-29);
  const d30 = await pageFetch(`/api/dashboard?from=${from30}&to=${today}`);
  const sum30 = (d30.body?.weekTrend ?? []).reduce((s, b) => s + b.revenue, 0);
  check(
    "30d range switches to monthly buckets",
    d30.body?.rangeMeta?.granularity === "monthly" && d30.body?.trendPeriod === "month",
    `${d30.body?.weekTrend?.length} month bucket(s)`
  );
  check(
    "30d monthly buckets sum ≈ rangeRevenue",
    Math.abs(sum30 - (d30.body?.rangeRevenue ?? -1)) < 1,
    `${sum30} vs ${d30.body?.rangeRevenue}`
  );

  const cmp = d30.body?.warehouseComparison ?? [];
  const cmpSum = cmp.reduce((s, w) => s + w.revenue, 0);
  check("warehouseComparison covers every active warehouse", cmp.length >= 2, `${cmp.length} locations`);
  check(
    "comparison revenues sum ≈ unscoped rangeRevenue",
    Math.abs(cmpSum - (d30.body?.rangeRevenue ?? -1)) < 1,
    `${cmpSum} vs ${d30.body?.rangeRevenue}`
  );

  const whList = await pageFetch("/api/warehouses");
  const wh = (whList.body?.warehouses ?? []).find((w) => !w.isDefault) ?? whList.body?.warehouses?.[1];
  if (wh) {
    const scoped = await pageFetch(`/api/dashboard?from=${from7}&to=${today}&warehouseId=${wh.id}`);
    const scopedSum = (scoped.body?.weekTrend ?? []).reduce((s, b) => s + b.revenue, 0);
    check("scoped+range: scoped trend sum ≤ unscoped trend sum", scopedSum <= sum7 + 1, `${scopedSum} ≤ ${sum7}`);
    check(
      "scoped+range: scoped revenue ≤ unscoped revenue",
      (scoped.body?.rangeRevenue ?? 0) <= (d7.body?.rangeRevenue ?? 0) + 1
    );
  }
  return { cmpNames: cmp.map((w) => w.name) };
}

async function phaseRangeUi(cmpNames) {
  console.log("\n── PHASE: in-page range switching + persistence ──");
  await nav("/dashboard");
  await waitFor(`/[\d][\d,]{2,}/.test(document.body.innerText)`, 20000);
  await sleep(1000);

  const before = (await text()) ?? "";
  check("today headline renders (case-insensitive)", before.toLowerCase().includes("revenue — today"));

  check("switch to Last 7 days", !!(await clickRangePreset("Last 7 days")));
  const seven = await waitFor(`document.body.innerText.toLowerCase().includes('revenue — last 7 days')`, 15000);
  check("headline relabels to Last 7 days", !!seven);
  await sleep(1500);
  const sevenText = (await text()) ?? "";
  check("figures change between Today and 7d", nums(before) !== nums(sevenText));
  check("hourly hint shows single-day note on multi-day range", sevenText.toLowerCase().includes("single-day range"));
  check(
    "prefs persisted to localStorage",
    (await evalJs(`(localStorage['elite-pos-dashboard-prefs'] || '').includes('"rangePreset":"7d"')`)) === true
  );

  check("switch to Last 30 days", !!(await clickRangePreset("Last 30 days")));
  const thirty = await waitFor(`document.body.innerText.toLowerCase().includes('revenue — last 30 days')`, 15000);
  check("headline relabels to Last 30 days", !!thirty);
  await sleep(1500);

  // Comparison card (renders when >1 warehouse)
  const withCard = (await text()) ?? "";
  check("warehouse-comparison card renders", withCard.toLowerCase().includes("warehouse comparison"));
  const visibleNames = (cmpNames || []).filter((n) => withCard.includes(n));
  check(
    "comparison card lists the locations",
    visibleNames.length >= Math.min(2, (cmpNames || []).length),
    visibleNames.join(", ")
  );
  await shot("dashboard-filters-30d");

  // Persistence across reload
  await nav("/dashboard");
  const restored = await waitFor(`document.body.innerText.toLowerCase().includes('revenue — last 30 days')`, 20000);
  check("range survives a full reload (per-user prefs)", !!restored);

  // Restore default for a clean handoff
  check("restore Today", !!(await clickRangePreset("Today")));
  await waitFor(`document.body.innerText.toLowerCase().includes('revenue — today')`, 15000);
  await shot("dashboard-filters-today");
}

/* ─────────────── MAIN ─────────────── */
const loggedIn = await h.login();
check("browser login succeeds", !!loggedIn);
if (!loggedIn) {
  console.log("ABORT: could not log in via UI");
  await h.finish();
  process.exit(1);
}

try {
  const { cmpNames } = await phaseRangeApi();
  await phaseRangeUi(cmpNames);
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
}

await h.finish();
