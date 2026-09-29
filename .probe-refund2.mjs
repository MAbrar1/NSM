import { createHarness, sleep } from "./scripts/audit-harness.mjs";
const h = await createHarness({ name: "probe2", loginPath: "/orders" });
const { evalJs, waitFor, nav, send, pos } = h;
const p = await import("@prisma/client");
const { PrismaClient } = p;
const prisma = new PrismaClient();
const order = await prisma.order.findFirst({
  orderBy: { createdAt: "desc" },
  select: { id: true, orderNumber: true, total: true },
});
await prisma.$disconnect();
console.log("order:", order.orderNumber);

await nav("/orders");
await waitFor(`document.body.innerText.includes(${JSON.stringify(order.orderNumber)})`, 15000);
console.log("text found; readyState:", await evalJs(`document.readyState`), "hydration checks...");

// Hydration signal: React-managed input enabled + tbody rows present
const hydrate = await evalJs(`(() => {
  const tr = document.querySelector('table tbody tr');
  const input = document.querySelector('input[type=number]');
  const checkbox = document.querySelector('input[type=checkbox]');
  return { tr, input, checkbox, bodyVisible: document.body.offsetParent !== null };
})()`);
console.log("hydration probe:", JSON.stringify(hydrate));

const t0 = Date.now();
await evalJs(`(() => {
  const els = [...document.querySelectorAll("button, a, span, td, th, tr, div")];
  const el = els.find(e => (e.innerText || "").trim() === ${JSON.stringify(order.orderNumber)})
    || els.find(e => (e.innerText || "").includes(${JSON.stringify(order.orderNumber)}) && (e.innerText || "").length < 120);
  if (!el) { console.log("no element found at", Date.now() - t0); return; }
  const r = el.getBoundingClientRect();
  el.click();
  console.log("clicked", el.tagName.toLowerCase(), el.className, r.x, r.y, Date.now() - t0);
})()`);
await sleep(2500);
const modal = await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes(${JSON.stringify(order.orderNumber)}))`, 12000);
console.log("modal after click, considering hydration:", !!modal, "elapsed", Date.now() - t0);

// Simulate a REAL user click timing: sleep until hydration signal, then click
const t1 = Date.now();
await evalJs(`(() => { document.querySelector('table tbody tr').click(); })()`);
await sleep(2500);
const modal2 = await waitFor(`[...document.querySelectorAll('[role=dialog]')].some(d => (d.innerText||'').includes(${JSON.stringify(order.orderNumber)}))`, 12000);
console.log("modal after row.click() post-hydration:", !!modal2, "elapsed", Date.now() - t1);

await h.close();
