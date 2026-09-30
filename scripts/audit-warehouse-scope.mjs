/* Per-warehouse scope QA for the dashboard.
   Verifies:
     • /api/dashboard?warehouseId= scopes consistently (scoped ≤ all)
     • unknown warehouseId falls back to all-warehouse data
     • /api/alerts?warehouseId= returns only that warehouse's alerts
     • the dashboard scope selector renders, switches, and re-queries

   CDP plumbing comes from scripts/audit-harness.mjs — see that file for why
   the Chrome profile lives outside the project and why a 5xx fails the run.

   Usage: node audit-warehouse-scope.mjs  (dev server on localhost:3000) */
import { createHarness, sleep } from "./audit-harness.mjs";

const h = await createHarness({
  name: "warehouse-scope",
  loginPath: "/dashboard",
  warmupPaths: ["/api/dashboard", "/api/warehouses", "/api/alerts"],
});

const { check, evalJs, waitFor, nav, text, shot, pageFetch } = h;

/* ─────────────── PHASES ─────────────── */

async function phaseScopedApi() {
  console.log("\n── PHASE: scoped API consistency ──");
  const all = await pageFetch("/api/dashboard");
  check(
    "unscoped dashboard answers",
    all.status === 200 && all.body && typeof all.body.rangeRevenue === "number",
    `status=${all.status}`
  );

  const whList = await pageFetch("/api/warehouses");
  const whs = whList?.body?.warehouses ?? [];
  check("warehouse list answers", whList.status === 200 && whs.length >= 1, `${whs.length} warehouses`);
  if (whs.length < 2) {
    console.log("SKIP: need ≥2 warehouses for scope assertions");
    return null;
  }
  // Prefer a non-default warehouse — the seeder routes ~55% of orders to the default.
  const wh = whs.find((w) => !w.isDefault) ?? whs[1];

  const scoped = await pageFetch(`/api/dashboard?warehouseId=${wh.id}`);
  check(
    "scoped dashboard answers",
    scoped.status === 200 && scoped.body && typeof scoped.body.rangeRevenue === "number",
    `status=${scoped.status}`
  );

  check(
    "scoped rangeRevenue ≤ all-warehouse total",
    scoped.body.rangeRevenue <= all.body.rangeRevenue + 0.009,
    `${scoped.body.rangeRevenue} ≤ ${all.body.rangeRevenue}`
  );
  check(
    "scoped monthRevenue ≤ all-warehouse total",
    scoped.body.monthRevenue <= all.body.monthRevenue + 0.009,
    `${scoped.body.monthRevenue} ≤ ${all.body.monthRevenue}`
  );
  check(
    "scoped weekTrend orders ≤ all-warehouse trend orders",
    scoped.body.weekTrend.reduce((s, d) => s + d.orders, 0) <= all.body.weekTrend.reduce((s, d) => s + d.orders, 0),
    `${scoped.body.weekTrend.reduce((s, d) => s + d.orders, 0)} ≤ ${all.body.weekTrend.reduce((s, d) => s + d.orders, 0)}`
  );

  // Unknown id must silently mean "all" (documented fallback).
  const bogus = await pageFetch("/api/dashboard?warehouseId=does-not-exist");
  check(
    "unknown warehouseId falls back to all data",
    bogus.status === 200 && Math.abs((bogus.body?.rangeRevenue ?? -1) - all.body.rangeRevenue) < 0.009
  );

  // Alerts scoping.
  const allA = await pageFetch("/api/alerts");
  const scA = await pageFetch(`/api/alerts?warehouseId=${wh.id}`);
  const allBelong = scA.status === 200 && (scA.body.alerts ?? []).every((a) => a.warehouseId === wh.id);
  check("scoped alerts all belong to the chosen warehouse", allBelong, `${(scA.body.alerts ?? []).length} alerts`);
  check(
    "scoped alert summary ≤ unscoped summary",
    (scA.body.summary?.total ?? 0) <= (allA.body.summary?.total ?? 0),
    `${scA.body.summary?.total} ≤ ${allA.body.summary?.total}`
  );
  return wh;
}

async function phaseScopeSwitch(wh) {
  console.log("\n── PHASE: in-page scope switch ──");
  await nav("/dashboard");
  const selReady = await waitFor(`!!document.querySelector('#dashboard-scope')`, 25000);
  check("scope selector renders with multiple warehouses", !!selReady);
  if (!selReady) return;

  // Wait for KPI data to land (currency amounts appear), then snapshot.
  await waitFor(`/[\d][\d,]{2,}/.test(document.body.innerText)`, 15000);
  await sleep(600);
  const beforeText = (await text()) ?? "";
  const nums = (s) => (s.match(/\d[\d,]*(\.\d+)?/g) || []).join(",");

  // React-controlled <select>: use the native value setter + change event.
  const switched = await evalJs(`(() => {
    const s = document.querySelector('#dashboard-scope');
    if (!s) return false;
    if (![...s.options].some(o => o.value === ${JSON.stringify(wh.id)})) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, ${JSON.stringify(wh.id)});
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  check("scope switch dispatched to the scoped warehouse", !!switched);

  const reflected = await waitFor(
    `document.querySelector('#dashboard-scope')?.value === ${JSON.stringify(wh.id)}`,
    5000
  );
  check("selector state reflects the scoped warehouse", !!reflected);

  await sleep(3000); // refetch + render settle
  const afterText = (await text()) ?? "";
  check("dashboard figures change after scoping", nums(beforeText) !== nums(afterText));

  // Restore "All warehouses" for a clean state.
  await evalJs(`(() => {
    const s = document.querySelector('#dashboard-scope');
    if (!s) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, '');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1500);
  const restored = await evalJs(`document.querySelector('#dashboard-scope')?.value === ''`);
  check("scope restored to all warehouses", !!restored);
  await shot("dashboard-warehouse-scope");
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
  const wh = await phaseScopedApi();
  if (wh) await phaseScopeSwitch(wh);
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
}

await h.finish();
