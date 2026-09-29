/* CHECKOUT DIAGNOSTIC
   Reproduces the POS checkout flow over HTTP against a running dev server and
   reports exactly where it breaks, then cleans up after itself.

   Usage: node audit-checkout-diag.mjs [baseUrl]     (default http://127.0.0.1:3001)

   It answers, in order:
     1. Can we authenticate?                     (login -> session cookie)
     2. What does /api/pos/search show for the cart product (stock, status)?
     3. What does POST /api/pos/checkout return   (status + body, verbatim)
     4. Did stock actually move?
   A disposable order is deleted and its stock restored at the end (net-zero).
*/
const BASE = process.argv[2] || "http://127.0.0.1:3001";
const EMAIL = "admin@elitepos.com";
const PASSWORD = "Admin@123";

const jar = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const ck = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  if (ck) headers["cookie"] = ck;
  const r = await fetch(BASE + path, { ...opts, headers, redirect: "manual" });
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of setc) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return r;
}

/**
 * GET a JSON endpoint, retrying while the dev server compiles. Reports the
 * status + content-type instead of throwing, so a non-JSON body (an HTML login
 * redirect, a dev error overlay) is visible rather than a parse crash.
 */
async function jsonReq(path, label) {
  let last = { status: 0, ct: "", body: null };
  for (let i = 0; i < 5; i++) {
    const r = await raw(path);
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("json")) return { status: r.status, ct, body: await r.json() };
    const text = await r.text();
    last = { status: r.status, ct, body: text };  
    if (label) console.log(`   … ${label}: ${r.status} ${ct || "(no content-type)"} — retrying`);
    await sleep(1500);
  }
  return last;
}

async function login() {
  const csrf = await (await raw("/api/auth/csrf")).json();
  const r = await raw("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email: EMAIL,
      password: PASSWORD,
      redirect: "false",
    }).toString(),
  });
  const ok = [...jar.keys()].some((k) => k.includes("session-token"));
  console.log(`1. login: ${ok ? "OK" : "FAILED"} (status ${r.status}, cookies: ${[...jar.keys()].join(", ") || "none"})`);
  return ok;
}

async function main() {
  console.log(`\n=== checkout diagnostic against ${BASE} ===\n`);

  if (!(await login())) {
    console.log("\n✖ Cannot authenticate — checkout will 401. Credentials or AUTH secret changed?\n");
    process.exitCode = 1;
    return;
  }

  const whRes = await jsonReq("/api/warehouses", "/api/warehouses");
  const whs = whRes.body?.warehouses ?? [];
  if (!Array.isArray(whRes.body?.warehouses)) {
    console.log(`   ⚠ /api/warehouses returned ${whRes.status} ${whRes.ct}`);
    console.log(`     body starts: ${String(whRes.body).slice(0, 160).replace(/\s+/g, " ")}`);
  }
  const wh = whs.find((w) => w.isDefault) ?? whs[0];
  console.log(`   warehouse: ${wh ? `${wh.name} (${wh.id})` : "NONE FOUND"}`);
  if (!wh) {
    console.log("\n✖ No warehouse exists — checkout will reject with no_warehouse.\n");
    process.exitCode = 1;
    return;
  }

  const searchRes = await jsonReq("/api/pos/search?limit=50", "/api/pos/search");
  const prods = searchRes.body?.products ?? [];
  console.log(`2. /api/pos/search -> ${prods.length} products`);
  if (prods.length === 0) {
    console.log("   ⚠ POS grid is EMPTY — nothing can be added to the cart.\n");
  }
  // Prefer something with real sellable stock so a stock error is meaningful.
  const prod =
    prods.find((p) => p.stockStatus === "ok" && (p.available ?? 0) > 1) ??
    prods.find((p) => (p.available ?? 0) > 1) ??
    prods[0];
  if (!prod) {
    console.log("\n✖ No product to test with.\n");
    process.exitCode = 1;
    return;
  }
  console.log(
    `   cart product: ${prod.name} [${prod.sku}] available=${prod.available} status=${prod.stockStatus} unitPrice=${prod.unitPrice}`
  );

  const qty = 1;
  const total = prod.unitPrice * qty;
  const payload = {
    warehouseId: wh.id,
    items: [
      {
        productId: prod.id,
        productName: prod.name,
        sku: prod.sku,
        quantity: qty,
        unit: prod.unit || "pcs",
        unitPrice: prod.unitPrice,
        costPrice: prod.costPrice || 0,
        discountAmount: 0,
        taxRate: prod.taxRate || 0,
        taxAmount: 0,
        total,
      },
    ],
    subtotal: total,
    taxAmount: 0,
    discountAmount: 0,
    total,
    paymentMethod: "cash",
    amountPaid: total,
    changeDue: 0,
  };

  // A browser always sends Origin on a same-origin POST; the CSRF middleware
  // compares it to the Host header. Node's fetch sends neither, so emulate it.
  const res = await raw("/api/pos/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, referer: `${BASE}/pos` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  console.log(`3. POST /api/pos/checkout -> ${res.status}`);
  console.log(`   body: ${JSON.stringify(body).slice(0, 900)}`);

  if (!res.ok) {
    console.log(`\n✖ CHECKOUT FAILS at the API layer (${res.status}).`);
    if (res.status === 401 || res.status === 403) console.log("   → permissions/session problem");
    if (res.status === 400 && body?.error) console.log("   → payload rejected by zod (see field errors above)");
    if (body?.code === "insufficient_stock") console.log("   → cart product genuinely lacks sellable stock");
    if (res.status === 500) console.log("   → server exception — check the dev-server console output");
    console.log("");
    process.exitCode = 1;
    return;
  }

  const orderId = body.order?.id ?? body.id;
  const orderNumber = body.order?.orderNumber ?? "?";
  console.log(`   ✓ order created: ${orderNumber} (${orderId})`);

  // Verify the stock actually moved, then undo everything (net-zero).
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  try {
    const row = await p.stockLevel.findFirst({
      where: { productId: prod.id, variantId: null, warehouseId: wh.id },
      select: { quantity: true },
    });
    console.log(`4. stock after sale: ${row?.quantity} (was ${prod.available})`);

    const order = await p.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (order) {
      for (const it of order.items) {
        const unrefunded = it.quantity - (it.refundedQuantity || 0);
        if (unrefunded <= 0) continue;
        await p.stockLevel.updateMany({
          where: { productId: it.productId, variantId: it.variantId, warehouseId: order.warehouseId },
          data: { quantity: { increment: unrefunded } },
        });
      }
      await p.inventoryMovement.deleteMany({ where: { referenceId: orderId } });
      await p.payment.deleteMany({ where: { orderId } });
      await p.orderItem.deleteMany({ where: { orderId } });
      await p.order.delete({ where: { id: orderId } });
      await p.auditLog.deleteMany({ where: { entityId: orderId } });
      console.log(`   cleaned up: order ${orderNumber} + its stock restored (net-zero)`);
    }
  } finally {
    await p.$disconnect();
  }

  console.log("\n✓ Checkout works at the API layer with this payload.\n");
}

main().catch((e) => {
  console.error("diagnostic crashed:", e);
  process.exitCode = 1;
});
