/* One-off probe: why doesn't the refund dialog open from the Orders detail modal?
   Mirrors audit5 phasePartialRefundUI with verbose dumps. */
import { createHarness, sleep } from "./audit-harness.mjs";
import { PrismaClient } from "@prisma/client";

const h = await createHarness({ name: "probe-refund", loginPath: "/orders" });
const { evalJs, waitFor, nav, send, pos } = h;

const p = new PrismaClient();
const sale = await p.order.findFirst({
  where: { items: { some: {} } },
  orderBy: { createdAt: "desc" },
  select: { id: true, orderNumber: true, total: true, items: { select: { id: true, quantity: true, total: true } } },
});
await p.$disconnect();
if (!sale) throw new Error("no orders in db");
console.log("using existing order:", sale.orderNumber, sale.id);

await nav("/orders");
await waitFor(`document.body.innerText.includes(${JSON.stringify(sale.orderNumber)})`, 15000);

await evalJs(`(() => {
  const els = [...document.querySelectorAll("button, a, span, td, th, tr, div")];
  const el = els.find(e => (e.innerText || "").trim() === ${JSON.stringify(sale.orderNumber)})
    || els.find(e => (e.innerText || "").includes(${JSON.stringify(sale.orderNumber)}) && (e.innerText || "").length < 120);
  if (!el) return false; el.click(); return true;
})()`);
const modal = await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes(${JSON.stringify(sale.orderNumber)}))`, 10000);
console.log("detail modal open:", !!modal);

const dump = await evalJs(`(() => {
  const dlgs = [...document.querySelectorAll('[role=dialog]')];
  return dlgs.map(d => ({
    text: (d.innerText || '').slice(0, 400),
    buttons: [...d.querySelectorAll('button')].map(b => ({ t: (b.innerText||'').trim(), disabled: b.disabled })),
  }));
})()`);
console.log("dialogs:", JSON.stringify(dump, null, 2));

const clicked = await evalJs(`(() => {
  const dlgs = [...document.querySelectorAll('[role=dialog]')];
  const d = dlgs.find(x => (x.innerText||'').includes(${JSON.stringify(sale.orderNumber)}));
  if (!d) return 'no-dialog';
  const btn = [...d.querySelectorAll('button')].find(b => (b.innerText || '').trim() === 'Refund');
  if (!btn) return 'no-btn: ' + [...d.querySelectorAll('button')].map(b => (b.innerText||'').trim()).join('|');
  btn.click();
  return 'clicked';
})()`);
console.log("refund click:", clicked);
await sleep(1200);

const after = await evalJs(`(() => {
  const dlgs = [...document.querySelectorAll('[role=dialog]')];
  return dlgs.map(d => (d.innerText || '').slice(0, 200));
})()`);
console.log("dialogs after click:", JSON.stringify(after, null, 2));
const itemsVisible = await evalJs(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes('Items to refund'))`);
console.log("Items to refund visible:", itemsVisible);

await h.close();
