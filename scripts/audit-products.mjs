/* Products page responsive + workflow QA.
   Verifies:
     • the filter bar, view toggle, table and grid all render at 3 widths
     • no horizontal overflow anywhere; columns degrade on mobile
     • the bulk-select workflow fires the API and self-restores
     • the display-currency picker converts amounts and reverts
     • ?view=/?status= deep links sync with the segmented toggle
     • scan-to-fill opens the scanner from the create dialog

   CDP plumbing comes from scripts/audit-harness.mjs — see that file for why
   the Chrome profile lives outside the project and why a 5xx fails the run.

   Usage: node audit-products.mjs   (dev server on localhost:3000) */
import { createHarness, sleep } from "./audit-harness.mjs";

const h = await createHarness({
  name: "products",
  loginPath: "/dashboard",
  warmupPaths: ["/api/products?pageSize=1", "/api/categories", "/api/brands", "/api/settings", "/api/fx/rates"],
});

const { check, evalJs, waitFor, nav, text, shot, setViewport, pageFetch } = h;

const overflowExpr = `(() => {
  const doc = document.documentElement;
  const bad = [...document.querySelectorAll('body *')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > doc.clientWidth + 2 || r.left < -2);
    })
    .slice(0, 4)
    .map(el => el.tagName + '.' + String(el.className).split(' ').slice(0, 3).join('.'));
  return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, bad };
})()`;

const rowCheckboxesExpr = `document.querySelectorAll('tbody input[type=checkbox]').length`;
const gridCardsExpr = `document.querySelectorAll('.product-card').length`;

/* Scope the filter-bar assertions to `.filters-bar`.
   A page-wide `document.querySelectorAll('select')` also counts the dashboard
   shell's warehouse picker, which renders in the header whenever the store has
   more than one warehouse — so the old "filter bar renders" check could pass
   with only two of the bar's three selects actually present. */
const filtersExpr = `(() => {
  const bar = document.querySelector('.filters-bar');
  if (!bar) return null;
  return {
    search: !!bar.querySelector('input[placeholder*="earch"]'),
    selects: bar.querySelectorAll('select').length,
    segmented: bar.querySelectorAll('.pos-segmented button').length,
    pageSelects: document.querySelectorAll('select').length,
  };
})()`;

async function ensureTableView() {
  await evalJs(`(() => {
    const btns = document.querySelectorAll('.pos-segmented button');
    if (btns[0]) btns[0].click();
    return true;
  })()`);
  await sleep(400);
}

/* Snapshot every product's status via the list API (for self-restoring bulk) */
async function snapshotStatuses() {
  const v = await evalJs(`(async () => {
    const out = {};
    let page = 1;
    for (;;) {
      const r = await fetch('/api/products?page=' + page + '&pageSize=100&status=all');
      const d = await r.json();
      for (const p of (d.items ?? [])) out[p.id] = p.status;
      if (!d.hasNext || page >= 20) break;
      page += 1;
    }
    return out;
  })()`);
  return v || null;
}

async function restoreStatuses(snapshot) {
  const groups = {};
  for (const [id, status] of Object.entries(snapshot)) (groups[status] ??= []).push(id);
  for (const [status, ids] of Object.entries(groups)) {
    await evalJs(`(async () => {
      const r = await fetch('/api/products/bulk', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ${JSON.stringify(ids)}, status: ${JSON.stringify(status)} }),
      });
      return r.status;
    })()`);
  }
}

/* ─────────────── PHASES ─────────────── */

async function phaseDesktop() {
  console.log("\n── PHASE: desktop 1440×900 ──");
  await setViewport(1440, 900);
  for (let attempt = 0; attempt < 3; attempt++) {
    await nav("/products");
    await waitFor(`${rowCheckboxesExpr} > 0 || document.body.innerText.length > 200`, 25000);
    const n = await evalJs(rowCheckboxesExpr);
    if (n > 0) break;
    await sleep(1500);
  }
  await sleep(1000);
  const t = (await text()) ?? "";

  check("products page renders", /products/i.test(t));
  const filters = await evalJs(filtersExpr);
  check(
    "filter bar renders (search + selects)",
    filters && filters.search && filters.selects >= 3,
    JSON.stringify(filters)
  );
  check("view toggle renders (table/grid)", filters && filters.segmented === 2, `${filters?.segmented} buttons`);

  const rows = await evalJs(rowCheckboxesExpr);
  check("table renders data rows", rows > 0, `${rows} rows`);
  const ovf = await evalJs(overflowExpr);
  check(
    "no horizontal overflow @1440",
    ovf && ovf.scrollW <= ovf.clientW + 2,
    ovf ? `scrollW=${ovf.scrollW} clientW=${ovf.clientW} ${JSON.stringify(ovf.bad)}` : "eval failed"
  );

  // Bulk bar: select all via the header checkbox
  await evalJs(`(() => {
    const th = document.querySelector('thead input[type=checkbox]');
    if (th && !th.checked) th.click();
    return true;
  })()`);
  await sleep(500);
  const bulk = await evalJs(`(() => {
    const bar = document.querySelector('.bulk-bar');
    return bar ? {
      present: true,
      selects: bar.querySelectorAll('select').length,
      printBtn: [...bar.querySelectorAll('button')].some(b => /print barcodes/i.test(b.innerText || '')),
      exportBtn: [...bar.querySelectorAll('button')].some(b => /export/i.test(b.innerText || '')),
    } : { present: false };
  })()`);
  check("bulk toolbar appears on select-all", bulk?.present === true);
  check(
    "bulk toolbar has 3 selects + export/print",
    bulk && bulk.selects === 3 && bulk.printBtn && bulk.exportBtn,
    JSON.stringify(bulk)
  );
  await shot("products-desktop-1440-bulkbar");

  // Grid view
  await evalJs(`(() => { const b = document.querySelectorAll('.pos-segmented button')[1]; if (b) b.click(); return true; })()`);
  await sleep(700);
  const cards = await evalJs(gridCardsExpr);
  check("grid view renders product cards", cards > 0, `${cards} cards`);
  await shot("products-desktop-1440-grid");

  // Click first card → edit dialog
  await evalJs(`(() => { const c = document.querySelector('.product-card'); if (c) c.click(); return true; })()`);
  await sleep(900);
  const dlg = await evalJs(`(() => {
    const h2 = [...document.querySelectorAll('h2')].find(h2 => /edit product/i.test(h2.textContent || ''));
    if (!h2) return { found: false };
    const panel = h2.closest('[data-radix-dialog-content]') || h2.closest('[role="dialog"]');
    const form = panel && panel.querySelector('form');
    const body = form && form.querySelector('div.overflow-y-auto');
    return {
      found: true,
      hasForm: !!form,
      scrollable: body ? body.scrollHeight > body.clientHeight : null,
      sh: body ? body.scrollHeight : 0,
      ch: body ? body.clientHeight : 0,
    };
  })()`);
  check("card click opens edit dialog", dlg?.found === true && dlg?.hasForm === true);
  check("edit form body is scrollable (no clipping)", dlg?.scrollable === true, dlg ? `sh=${dlg.sh} ch=${dlg.ch}` : "");
  await shot("products-edit-dialog");
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('[data-radix-dialog-content] button, [role="dialog"] button')];
    const cancel = btns.find(b => /cancel/i.test(b.innerText || ''));
    if (cancel) cancel.click();
    return true;
  })()`);
  await sleep(500);
}

async function phaseTablet() {
  console.log("\n── PHASE: tablet 768×1024 ──");
  await setViewport(768, 1024);
  await nav("/products");
  await waitFor(`${rowCheckboxesExpr} > 0`, 25000);
  await sleep(800);
  const ovf = await evalJs(overflowExpr);
  check("no horizontal overflow @768", ovf && ovf.scrollW <= ovf.clientW + 2, ovf ? `scrollW=${ovf.scrollW}` : "eval failed");
  await shot("products-tablet-768");
}

async function phaseMobile() {
  console.log("\n── PHASE: mobile 375×812 ──");
  await setViewport(375, 812);
  for (let attempt = 0; attempt < 3; attempt++) {
    await nav("/products");
    await waitFor(`${rowCheckboxesExpr} > 0 || ${gridCardsExpr} > 0`, 25000);
    const n = await evalJs(rowCheckboxesExpr);
    if (n > 0) break;
    await sleep(1500);
  }
  await sleep(800);
  await ensureTableView();
  await sleep(400);

  const ovf = await evalJs(overflowExpr);
  check(
    "no horizontal overflow @375",
    ovf && ovf.scrollW <= ovf.clientW + 2,
    ovf ? `scrollW=${ovf.scrollW} clientW=${ovf.clientW} ${JSON.stringify(ovf.bad)}` : "eval failed"
  );

  const cells = await evalJs(`(() => {
    const row = document.querySelector('tbody tr');
    if (!row) return { visible: -1 };
    const tds = [...row.querySelectorAll('td')];
    return {
      total: tds.length,
      visible: tds.filter(td => getComputedStyle(td).display !== 'none').length,
    };
  })()`);
  check(
    "table columns degrade on mobile (hidden cols)",
    cells && cells.visible > 0 && cells.visible < cells.total,
    JSON.stringify(cells)
  );

  // Grid view on mobile — cards must fit the viewport
  await evalJs(`(() => { const b = document.querySelectorAll('.pos-segmented button')[1]; if (b) b.click(); return true; })()`);
  await sleep(600);
  const cardFit = await evalJs(`(() => {
    const c = document.querySelector('.product-card');
    if (!c) return { found: false };
    const r = c.getBoundingClientRect();
    return { found: true, w: Math.round(r.width), fits: r.right <= window.innerWidth + 2 };
  })()`);
  check("grid cards fit mobile viewport", cardFit?.found === true && cardFit?.fits === true, cardFit ? `w=${cardFit.w}` : "");
  await shot("products-mobile-375-grid");
  await ensureTableView();
}

async function phaseBulkWorkflow() {
  console.log("\n── PHASE: bulk workflow (desktop, self-restoring) ──");
  await setViewport(1440, 900);
  await nav("/products");
  let bulkRows = await waitFor(`${rowCheckboxesExpr} > 0`, 25000);
  if (!bulkRows) {
    // A transient hydration retry can leave the tree empty; one fresh
    // navigation re-issues the data fetch.
    console.log("   retrying bulk-phase nav…");
    await nav("/products");
    bulkRows = await waitFor(`${rowCheckboxesExpr} > 0`, 30000);
  }
  await sleep(800);
  await ensureTableView();

  const snapshot = await snapshotStatuses();
  check(
    "status snapshot collected",
    !!snapshot && Object.keys(snapshot).length > 0,
    snapshot ? `${Object.keys(snapshot).length} products` : ""
  );

  // Intercept the bulk POST so we can assert it fired + capture the payload
  await evalJs(`(() => {
    window.__bulk = null;
    const orig = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await orig(...args);
      try {
        if (String(args[0]).includes('/api/products/bulk') && args[1] && args[1].method === 'PUT') {
          window.__bulk = { status: res.status, body: JSON.parse(args[1].body) };
        }
      } catch {}
      return res;
    };
    window.confirm = () => true;
    return true;
  })()`);

  // Select all rows, then use the status select in the bulk bar
  await evalJs(`(() => {
    const th = document.querySelector('thead input[type=checkbox]');
    if (th && !th.checked) th.click();
    return true;
  })()`);
  await sleep(500);
  const fired = await evalJs(`(() => {
    const sel = document.querySelector('.bulk-bar select');
    if (!sel) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'active');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  check("bulk status select triggers request", fired === true);
  const bulk = await waitFor(`window.__bulk`, 10000);
  check(
    "bulk API returned 200",
    bulk && bulk.status === 200,
    bulk ? `http=${bulk.status} ids=${bulk.body?.ids?.length}` : "no request captured"
  );
  const toast = await waitFor(`/updated/i.test(document.body.innerText)`, 8000);
  check("success toast shown", toast === true);
  const cleared = await evalJs(`!document.querySelector('.bulk-bar')`);
  check("selection cleared after bulk update", cleared === true);
  await shot("products-after-bulk");

  // Self-restore original statuses
  if (snapshot) {
    await restoreStatuses(snapshot);
    const after = await snapshotStatuses();
    const drift = Object.keys(snapshot).filter((id) => after?.[id] !== snapshot[id]);
    check("original statuses restored", drift.length === 0, drift.length ? `${drift.length} drifted` : "all match");
  }
}

async function phaseCurrency() {
  console.log("\n── PHASE: currency conversion (desktop) ──");
  await setViewport(1440, 900);

  // Warm the FX route. This used to hit it from Node with `{ cookie:
  // sessionCookie }` — but `sessionCookie` was never defined anywhere, so the
  // reference threw and the bare `catch` swallowed it four times over. Warm it
  // from the page instead, where the browser's own session already applies.
  const fx = await pageFetch("/api/fx/rates");
  console.log(`FX route warmed (${fx.status})`);

  await nav("/products");
  await waitFor(`${rowCheckboxesExpr} > 0`, 25000);
  await sleep(1000);

  // Picker renders in the topbar
  const picker = await evalJs(`(() => {
    const btn = document.querySelector('[title="Display currency"]') ||
      [...document.querySelectorAll('button')].find(b => /USD|PKR|EUR/.test((b.textContent || '').trim()) && b.getAttribute('aria-haspopup') === 'listbox');
    return btn ? { found: true } : { found: false };
  })()`);
  check("currency picker renders in topbar", picker?.found === true);

  // Open picker — click-retry: early in hydration React may not have
  // attached handlers yet, so a single click can be a silent no-op.
  let opened = false;
  for (let i = 0; i < 5 && !opened; i++) {
    await evalJs(`(() => {
      const btn = document.querySelector('[title="Display currency"]') ||
        [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-haspopup') === 'listbox');
      if (btn) btn.click();
      return true;
    })()`);
    opened = await waitFor(`!!document.querySelector('[role="listbox"]')`, 3000);
  }
  // Poll for the option list (the popover render can lag on a busy dev server).
  const optsReady = await waitFor(`document.querySelectorAll('[role="option"]').length > 0`, 10000);
  // Store base is PKR — switch display to USD, assert conversion, revert.
  // Select-and-verify: retry while the listbox is still open (a no-op click
  // leaves it open; a real selection closes it).
  let choseUsd = false;
  await evalJs(`(() => { delete window.__auditUsdDone; return true; })()`);
  if (optsReady) {
    for (let i = 0; i < 10 && !choseUsd; i++) {
      const state = await evalJs(`(() => {
        const lb = document.querySelector('[role="listbox"]');
        if (!lb) {
          if (window.__auditUsdDone) return "done";
          const btn = document.querySelector('[title="Display currency"]') ||
            [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-haspopup') === 'listbox');
          if (btn) btn.click();
          return "reopened";
        }
        const usd = [...lb.querySelectorAll('[role="option"]')].find(o => /USD/.test(o.textContent || ''));
        if (usd) { usd.click(); window.__auditUsdDone = true; }
        return "open";
      })()`);
      if (state === "done") { choseUsd = true; break; }
      await sleep(700);
    }
  }
  check("USD selectable in picker", opened === true && choseUsd === true);
  // Poll until converted amounts actually paint (provider fetch + re-render).
  const converted = (await waitFor(`/\\$[\\d,]+/.test(document.body.innerText)`, 15000))
    ? await evalJs(`(() => {
        const txt = document.body.innerText;
        return { usdSeen: true, sample: (txt.match(/\\$[\\d,]+(\\.\\d{1,2})?/) || [""])[0] };
      })()`)
    : { usdSeen: false, sample: "no $ amounts found" };

  check("amounts re-render in USD (live conversion)", converted?.usdSeen === true, converted?.sample || "no $ amounts found");

  // URL/round-trip: switch back to store default (reopen + select-and-verify;
  // the window flag disambiguates "not yet opened" from "successfully closed").
  for (let i = 0; i < 10; i++) {
    const state = await evalJs(`(() => {
      const lb = document.querySelector('[role="listbox"]');
      if (!lb) {
        if (window.__auditRevertDone) return "done";
        const btn = document.querySelector('[title="Display currency"]') ||
          [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-haspopup') === 'listbox');
        if (btn) btn.click();
        return "reopened";
      }
      const base = [...lb.querySelectorAll('[role="option"]')].find(o => /PKR/.test(o.textContent || '')) || lb.querySelector('[role="option"]');
      if (base) { base.click(); window.__auditRevertDone = true; }
      return "open";
    })()`);
    if (state === "done") break;
    await sleep(700);
  }
  await evalJs(`(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    const base = opts.find(o => /PKR/.test(o.textContent || '')) || opts[0];
    if (base) base.click();
    return true;
  })()`);
  // Poll until base amounts repaint (and $ is gone).
  await waitFor(`/Rs|₨|PKR/.test(document.body.innerText)`, 10000);
  await sleep(500);
  const reverted = await evalJs(`(() => {
    const txt = document.body.innerText;
    return { pkr: /Rs|₨|PKR/.test(txt), dollar: /\\$[\\d,]+(\\.\\d{1,2})?/.test(txt) };
  })()`);
  check("reverts to store base (PKR) cleanly", reverted && reverted.pkr && !reverted.dollar, JSON.stringify(reverted));
  await shot("products-currency-picker");
}

async function phaseUrlSync() {
  console.log("\n── PHASE: URL sync (desktop) ──");
  await setViewport(1440, 900);
  await nav("/products?view=grid&status=active");
  // Deterministic wait: the post-mount URL effect first applies ?view=grid,
  // then the grid fetch paints cards.
  const linkReady = await waitFor(`${gridCardsExpr} > 0 || ${rowCheckboxesExpr} > 0`, 30000);
  if (!linkReady) {
    console.log("   retrying deep-link nav…");
    await nav("/products?view=grid&status=active");
    await waitFor(`${gridCardsExpr} > 0 || ${rowCheckboxesExpr} > 0`, 30000);
  }
  await sleep(1000);

  const deepLink = await evalJs(`(() => ({
    grid: document.querySelectorAll('.product-card').length,
    url: location.search,
  }))()`);
  check(
    "deep link opens grid view with status filter",
    deepLink && deepLink.grid > 0 && /view=grid/.test(deepLink.url) && /status=active/.test(deepLink.url),
    JSON.stringify(deepLink)
  );

  // Switch back to table → URL should drop view=grid (replaceState sync)
  await evalJs(`(() => { const b = document.querySelectorAll('.pos-segmented button')[0]; if (b) b.click(); return true; })()`);
  const tblReady = await waitFor(`${rowCheckboxesExpr} > 0`, 20000);
  const afterToggle = await evalJs(`(() => ({ cards: document.querySelectorAll('.product-card').length, url: location.search }))()`);
  check(
    "URL syncs when view toggles back to table",
    tblReady && afterToggle && afterToggle.cards === 0 && !/view=grid/.test(afterToggle.url),
    JSON.stringify(afterToggle)
  );
  await shot("products-url-sync");
}

async function phaseScanButton() {
  console.log("\n── PHASE: scan-to-fill (desktop) ──");
  await setViewport(1440, 900);
  await nav("/products");
  await waitFor(`${rowCheckboxesExpr} > 0`, 25000);
  await sleep(800);

  // Open create dialog — retry the click up to 3×: if the first click
  // lands before React attaches the handler, the dialog never opens.
  let openedCreate = false;
  for (let attempt = 0; attempt < 3 && !openedCreate; attempt++) {
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /add product/i.test(b.innerText || ''));
      if (btn) btn.click();
      return true;
    })()`);
    openedCreate =
      (await waitFor(`[...document.querySelectorAll('h2')].some(h => /add product/i.test(h.textContent || ''))`, 8000)) !== null;
  }
  await sleep(400);
  const scanBtn = await evalJs(`(() => {
    const dlg = [...document.querySelectorAll('h2')].find(h => /add product/i.test(h.textContent || ''));
    const panel = dlg && (dlg.closest('[data-radix-dialog-content]') || dlg.closest('[role="dialog"]'));
    const btn = panel && panel.querySelector('button[aria-label="Scan barcode"]');
    if (!btn) return { found: false };
    btn.click();
    return { found: true };
  })()`);
  check("scan button present in product form", openedCreate === true && scanBtn?.found === true);
  // Poll for the scanner dialog instead of a fixed sleep.
  const scannerReady = await waitFor(
    `[...document.querySelectorAll('h2')].some(h2 => /scan barcode/i.test(h2.textContent || ''))`,
    12000
  );
  const scannerDialog = await evalJs(`(() => {
    const h2s = [...document.querySelectorAll('h2')].map(h => (h.textContent || '').trim());
    return { titles: h2s.slice(0, 4), hasScanner: h2s.some(h2 => /scan barcode/i.test(h2)) };
  })()`);
  check(
    "scanner dialog opens from form",
    scannerReady === true && scannerDialog?.hasScanner === true,
    JSON.stringify(scannerDialog?.titles)
  );
  await shot("products-scan-dialog");
  // Close scanner + create dialogs
  await evalJs(`(() => {
    const cancels = [...document.querySelectorAll('[data-radix-dialog-content] button, [role="dialog"] button')].filter(b => /cancel|close/i.test(b.innerText || ''));
    cancels.forEach(b => b.click());
    return true;
  })()`);
  await sleep(500);
}

/* ─────────────── MAIN ─────────────── */
const loggedIn = await h.login();
check("browser login succeeds", loggedIn === true);
if (!loggedIn) {
  console.log("ABORT: could not log in via UI");
  await h.finish();
  process.exit(1);
}

try {
  await phaseDesktop();
  await phaseTablet();
  await phaseMobile();
  await phaseBulkWorkflow();
  await phaseCurrency();
  await phaseUrlSync();
  await phaseScanButton();
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
}

await h.finish();
