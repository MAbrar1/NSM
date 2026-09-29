/* POS page responsive + visual QA.
   Verifies at 3 viewports:
     • /pos renders: header, product grid, cart rail, pay button
     • No horizontal overflow at any width (375 / 768 / 1440)
     • Cart rail hidden on mobile, visible on md+ (Tailwind breakpoint contract)
     • Mobile trigger bar appears only when a cart item exists
     • Payment modal opens and lays out (tiles, quick cash, total)
     • Product details dialog opens in its two-column layout

   The CDP plumbing, the sign-in flow and the cart driver all come from
   scripts/audit-harness.mjs — see that file for why the Chrome profile lives
   outside the project and why a 5xx now fails the run.

   Usage: node audit-pos.mjs   (server on localhost:3000) */
import { createHarness, sleep, POS } from "./scripts/audit-harness.mjs";

const h = await createHarness({
  name: "pos",
  loginPath: "/pos",
  viewport: { width: 1440, height: 900, mobile: false },
  // Compiled before any assertion runs, so a later 5xx is a real defect.
  warmupPaths: [
    "/api/pos/search?limit=1",
    "/api/categories",
    "/api/settings",
    "/api/warehouses",
    "/api/products/lookup?status=low,out&limit=1",
  ],
});

const { check, evalJs, waitFor, nav, text, shot, setViewport, pos } = h;

// Does any element stick out past the viewport width?
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

/* ─────────────── PHASES ─────────────── */

async function phaseDesktop() {
  console.log("\n── PHASE: desktop 1440×900 ──");
  await setViewport(1440, 900);
  // The product grid is the slowest thing on the page; retry the load rather
  // than assert against a half-rendered shell.
  for (let attempt = 0; attempt < 3; attempt++) {
    await nav("/pos");
    await waitFor(`${pos.cardCountExpr} > 0 || document.body.innerText.length > 200`, 25000);
    if ((await pos.cardCount()) > 0) break;
    await sleep(1500);
  }
  await sleep(1200);
  const t = (await text()) ?? "";

  check("POS header renders", t.includes("Point of Sale"));

  const rail = await pos.rail();
  check(
    "desktop cart rail visible",
    rail?.found === true && rail?.visible === true,
    rail?.found ? `w=${rail.width}` : JSON.stringify(rail)
  );

  const cards = await pos.cardCount();
  check("product grid has cards", cards > 0, `${cards} cards`);

  const ovf = await evalJs(overflowExpr);
  check(
    "no horizontal overflow @1440",
    ovf && ovf.scrollW <= ovf.clientW + 2,
    ovf ? `scrollW=${ovf.scrollW} clientW=${ovf.clientW} ${JSON.stringify(ovf.bad)}` : "eval failed"
  );

  // Product details dialog (two-column)
  const opened = await evalJs(`(() => {
    const card = document.querySelector('${POS.card}');
    if (!card) return false;
    const btn = card.querySelector('button[aria-label="Details"], button[title="Details"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check("details button opens dialog", opened === true);
  if (opened) {
    await sleep(500);
    const dlg = await evalJs(`(() => {
      const h2 = [...document.querySelectorAll('h2')].find(x => (x.textContent || '').toLowerCase().includes('product details'));
      if (!h2) return { found: false };
      const panel = h2.closest('[data-radix-dialog-content]') || h2.closest('[role="dialog"]') || h2.parentElement?.parentElement;
      const grid = panel && [...panel.querySelectorAll('div')].find(d => /md:grid-cols-2/.test(d.className || ''));
      return { found: true, twoCol: !!grid };
    })()`);
    check("details dialog two-column grid present", dlg?.found === true && dlg?.twoCol === true);
    await shot("pos-details-dialog-desktop");
    await evalJs(`(() => {
      const h2 = [...document.querySelectorAll('h2')].find(x => (x.textContent || '').toLowerCase().includes('product details'));
      const panel = h2 && (h2.closest('[data-radix-dialog-content]') || h2.closest('[role="dialog"]'));
      const close = panel && [...panel.querySelectorAll('button')].find(b => (b.innerText || '').trim().toLowerCase() === 'close');
      if (close) close.click();
    })()`);
    await sleep(400);
  }
  await shot("pos-desktop-1440");
}

async function phaseTablet() {
  console.log("\n── PHASE: tablet 768×1024 ──");
  await setViewport(768, 1024);
  await nav("/pos");
  await sleep(1500);

  const rail = await pos.rail();
  check(
    "cart rail visible @md (768px)",
    rail?.found === true && rail?.width > 100,
    rail?.found ? `w=${rail.width}` : JSON.stringify(rail)
  );

  const ovf = await evalJs(overflowExpr);
  check("no horizontal overflow @768", ovf && ovf.scrollW <= ovf.clientW + 2, ovf ? `scrollW=${ovf.scrollW}` : "eval failed");
  await shot("pos-tablet-768");
}

async function phaseMobile() {
  console.log("\n── PHASE: mobile 375×812 ──");
  await setViewport(375, 812);
  await nav("/pos");
  await waitFor(`${pos.cardCountExpr} > 0`, 25000);
  await sleep(800);

  const rail = await pos.railDisplay();
  check("cart rail hidden on mobile", rail && (rail.display === "none" || rail.display === ""), rail ? rail.display : "no rail");

  const ovf = await evalJs(overflowExpr);
  check(
    "no horizontal overflow @375",
    ovf && ovf.scrollW <= ovf.clientW + 2,
    ovf ? `scrollW=${ovf.scrollW} clientW=${ovf.clientW} ${JSON.stringify(ovf.bad)}` : "eval failed"
  );
  await shot("pos-mobile-375-empty");

  // The cart driver already fills + confirms the unit-quantity dialog.
  const added = await pos.addLineToCart();
  if (added) {
    await sleep(600);
    const bar = await waitFor(`(() => {
      const el = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-expanded') !== null && /items/.test(b.innerText || ''));
      return el ? true : false;
    })()`, 8000);
    check("mobile cart trigger bar appears after add", bar === true);
    await sleep(400);
    const ovf2 = await evalJs(overflowExpr);
    check("no overflow with cart bar @375", ovf2 && ovf2.scrollW <= ovf2.clientW + 2, ovf2 ? `scrollW=${ovf2.scrollW}` : "eval failed");

    // Open the mobile drawer
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-expanded') !== null && /items/.test(x.innerText || ''));
      if (b) b.click();
    })()`);
    await sleep(700);
    const drawer = await evalJs(`(() => {
      const el = document.querySelector('.animate-slide-up');
      if (!el) return { open: false };
      const r = el.getBoundingClientRect();
      return { open: true, visible: r.height > 100 };
    })()`);
    check("mobile cart drawer opens", drawer?.open === true && drawer?.visible === true);
    await shot("pos-mobile-375-drawer");
    // Close drawer via its close button
    await evalJs(`(() => {
      const el = document.querySelector('.animate-slide-up');
      const x = el && [...el.querySelectorAll('button')].find(b => /close/i.test(b.getAttribute('aria-label') || ''));
      if (x) x.click();
    })()`);
    await sleep(400);
  } else {
    console.log("  (skip cart-bar checks — no in-stock product card available)");
  }
}

async function phasePaymentModal() {
  console.log("\n── PHASE: payment modal (desktop) ──");
  await setViewport(1440, 900);
  await nav("/pos");
  const added = await pos.addLineToCart();
  check("product added to cart", added === true);
  if (!added) return;

  const payOpened = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^pay/i.test((b.innerText || '').trim()) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check("pay button opens payment modal", payOpened === true);
  if (!payOpened) return;

  // Radix portal render — wait for the tiles before asserting
  const tilesReady = await waitFor(`document.querySelectorAll('${POS.payTile}').length === 4`, 8000);
  const modal = await evalJs(`(() => {
    const tiles = document.querySelectorAll('${POS.payTile}').length;
    const row = document.querySelector('${POS.cashQuick}');
    const chips = row ? [...row.querySelectorAll('${POS.cashQuickBtn}')] : [];
    const labels = chips.map(c => (c.innerText || '').trim());
    // The amount field is seeded with the exact total, so its value IS the bill.
    const field = row && row.parentElement ? row.parentElement.querySelector('input[type="number"]') : null;
    const bill = field ? Number(field.value) : NaN;
    // Denomination chips are bare numbers; the "Round up" and "Exact" chips
    // carry a text prefix, so this separates the two kinds without parsing.
    const denoms = labels.filter(l => /^[0-9]+([.,][0-9]+)?$/.test(l)).map(l => Number(l.replace(',', '.')));
    const total = [...document.querySelectorAll('p, span')].some(el => /^amount due/i.test((el.textContent || '').trim()));
    return { tiles, quick: chips.length, denoms, bill, total };
  })()`);
  check("payment tiles render (4 methods)", tilesReady === true && modal.tiles === 4, `${modal.tiles} tiles`);
  // The modal deliberately offers only denominations that settle the bill
  // (smaller chips are mis-taps), so the chip COUNT moves with the cart total
  // — assert the rule itself rather than a fixed number.
  check("quick cash chips render", modal.quick >= 1, `${modal.quick} chips`);
  check(
    "every cash denomination settles the bill",
    modal.denoms.length > 0 && Number.isFinite(modal.bill) && modal.denoms.every((d) => d + 0.01 >= modal.bill),
    `bill=${modal.bill} denoms=[${modal.denoms.join(", ")}]`
  );
  check("amount due block renders", modal.total === true);
  await shot("pos-payment-modal");
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
  await phasePaymentModal();
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
}

await h.finish();
