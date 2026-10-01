/* ═══════════════════════════════════════════════════════════════
   VERIFY API — full-feature end-to-end sweep (72 checks).

   Boots against a RUNNING production server (`next start`) on an
   ISOLATED database copy — never your dev.db:

     cp prisma/dev.db prisma/e2e.db
     DATABASE_URL="file:./e2e.db" AUTH_SECRET=e2e-secret \
       NEXTAUTH_SECRET=e2e-secret AUTH_URL=http://localhost:3200 \
       NEXTAUTH_URL=http://localhost:3200 npx next start -p 3200
     npm run verify:api

   Covers: auth + CSRF contract (POSTs need a same-origin Origin),
   reference data, products CRUD (MAJOR-unit boundary via
   priceSchema; storage is cents via majorToCents), checkout money
   math in INTEGER CENTS + stock decrement + tamper/underpayment
   guards, the khata credit cycle (sale → dues → FIFO settlement),
   refunds, inventory adjust/transfer/reserve, PO money math and
   the draft→pending→ordered status machine, users/audit, and every
   system endpoint. Exits non-zero on any failure.
   ═══════════════════════════════════════════════════════════════ */
const BASE = process.env.E2E_BASE || "http://localhost:3200";
const jar = new Map();
const results = [];
let section = "";

function ok(name, cond, detail = "") {
  results.push({ section, name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  [${section}] ${name}${detail ? " — " + detail : ""}`);
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      origin: BASE,
      referer: BASE + "/",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      cookie: cookieHeader(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  absorb(res);
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  return { status: res.status, json };
}
const GET = (p) => req("GET", p);
const POST = (p, b) => req("POST", p, b);
const PUT = (p, b) => req("PUT", p, b);
const DEL = (p) => req("DELETE", p);

/* ── auth ──────────────────────────────────────────────────── */
section = "auth";
{
  const csrf = (await GET("/api/auth/csrf")).json;
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, referer: BASE + "/", cookie: cookieHeader() },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: "admin@elitepos.com", password: "Admin@123", redirect: "false" }).toString(),
    redirect: "manual",
  });
  absorb(res);
  ok("credentials login sets session", [...jar.keys()].some((k) => k.includes("session-token")));
  const session = await GET("/api/auth/session");
  ok("session resolves super_admin", session.json?.user?.role === "super_admin");
  ok("registration status endpoint", (await GET("/api/auth/registration-status")).status === 200);
}

/* ── reference data ────────────────────────────────────────── */
section = "reference";
let categoryId, brandId, warehouseId;
{
  const cats = (await GET("/api/categories")).json;
  const catArr = cats?.categories ?? cats;
  ok("categories list", Array.isArray(catArr) && catArr.length > 0, `${catArr?.length} rows`);
  categoryId = catArr?.[0]?.id;
  const created = await POST("/api/categories", { name: "E2E Cat " + Date.now() });
  const catId = created.json?.category?.id;
  ok("category create", created.status === 201 && !!catId, JSON.stringify(created.json?.error ?? created.status));
  if (catId) {
    ok("category update", (await PUT(`/api/categories/${catId}`, { name: "E2E Cat Renamed" })).status === 200);
    ok("category delete", (await DEL(`/api/categories/${catId}`)).status === 200);
  }
  const brands = (await GET("/api/brands")).json;
  const brandArr = brands?.brands ?? brands;
  ok("brands list", Array.isArray(brandArr), `${brandArr?.length ?? "?"} rows`);
  brandId = brandArr?.[0]?.id;
  const whs = (await GET("/api/warehouses")).json;
  const whArr = whs?.warehouses ?? whs;
  warehouseId = whArr?.[0]?.id;
  ok("warehouses list + one exists", Array.isArray(whArr) && !!warehouseId, `${whArr?.length} rows`);
  ok("stock-summary", (await GET("/api/warehouses/stock-summary")).status === 200);
  ok("settings GET", (await GET("/api/settings")).status === 200);
  ok("fx rates", (await GET("/api/fx/rates")).status === 200);
}

/* ── products CRUD (MAJOR-unit prices at this boundary) ────── */
section = "products";
let productId;
const uniq = "E2E-" + Date.now().toString(36).toUpperCase();
{
  const list = (await GET("/api/products?page=1&limit=5")).json;
  ok("products list", Array.isArray(list?.items) && list.items.length > 0, `${list?.items?.length} rows, ${list?.totalPages} pages`);

  // Send 1250.00 major → app must store 125000 cents via majorToCents.
  const created = await POST("/api/products", {
    name: "E2E Widget", sku: uniq, categoryId, brandId: brandId || "",
    unitPrice: 1250, costPrice: 800, taxRate: 5,
    minStockLevel: 3, unit: "pcs", status: "active", trackInventory: true,
  });
  productId = created.json?.product?.id;
  ok("product create (major→cents: 1250→125000)", created.status === 201 && created.json?.product?.unitPrice === 125000, `stored=${created.json?.product?.unitPrice}`);

  const got = (await GET(`/api/products/${productId}`)).json;
  ok("product GET by id + totalStock", got?.product?.sku === uniq && typeof got?.product?.totalStock === "number", `totalStock=${got?.product?.totalStock}`);

  const upd = await PUT(`/api/products/${productId}`, {
    name: "E2E Widget v2", sku: uniq, categoryId,
    unitPrice: 1500, costPrice: 800, taxRate: 5, minStockLevel: 3,
  });
  ok("product update (1500 major → 150000 cents)", upd.status === 200 && upd.json?.product?.unitPrice === 150000, `stored=${upd.json?.product?.unitPrice}`);

  const lookup = (await GET(`/api/products/lookup?q=${uniq}`)).json;
  ok("products lookup (q param) finds it", JSON.stringify(lookup).includes(uniq));

  const dup = await POST("/api/products", { name: "Dup", sku: uniq, categoryId, unitPrice: 100, costPrice: 50 });
  ok("duplicate SKU rejected", dup.status === 409 || dup.status === 400, `status ${dup.status}`);

  const bad = await POST("/api/products", { name: "Bad", sku: uniq + "X", categoryId, unitPrice: 1.999, costPrice: 0 });
  ok("3-decimal price rejected (multipleOf 0.01)", bad.status === 400, `status ${bad.status}`);
}

/* ── checkout (INTEGER CENTS at this boundary) ─────────────── */
section = "checkout";
let orderId;
const CENTS_UNIT = 150000, CENTS_COST = 80000;
{
  // Stock the shelf first: a fresh product starts at 0 and the checkout
  // stock guard (correctly) refuses to oversell.
  const seed = await POST("/api/inventory/adjust", { productId, warehouseId, quantity: 10, type: "count", notes: "e2e opening stock" });
  ok("opening stock +10 accepted", seed.status === 200 || seed.status === 201, JSON.stringify(seed.json?.error ?? seed.status).slice(0, 100));

  const before = (await GET(`/api/products/${productId}`)).json?.product?.totalStock;
  ok("opening stock visible (10)", before === 10, `totalStock=${before}`);

  const search = (await GET(`/api/pos/search?q=${uniq}&warehouseId=${warehouseId}`)).json;
  ok("pos search finds product", JSON.stringify(search).includes(uniq));
  ok("global search", (await GET("/api/search?q=" + uniq)).status === 200);

  // 2 × 150000 = 300000; −10% (30000) = 270000; +5% tax (13500) = 283500
  const chk = await POST("/api/pos/checkout", {
    warehouseId,
    items: [{ productId, productName: "E2E Widget v2", sku: uniq, quantity: 2, unitPrice: CENTS_UNIT, costPrice: CENTS_COST, discountType: "percentage", discountValue: 10, discountAmount: 30000, taxRate: 5, taxAmount: 13500, total: 283500 }],
    subtotal: 300000, taxAmount: 13500, discountAmount: 30000, total: 283500,
    paymentMethod: "cash", amountPaid: 300000, changeDue: 16500, loyaltyPointsRedeemed: 0,
  });
  ok("checkout accepted (exact money math)", chk.status === 201 || chk.status === 200, JSON.stringify(chk.json?.error ?? chk.status).slice(0, 140));
  orderId = chk.json?.order?.id ?? chk.json?.id;

  const after = (await GET(`/api/products/${productId}`)).json?.product?.totalStock;
  ok("stock decremented by 2", before - after === 2, `${before} → ${after}`);

  const odetail = (await GET(`/api/orders/${orderId}`)).json;
  const total = odetail?.order?.total ?? odetail?.total;
  ok("order total exactly 283500", total === 283500, `total=${total}`);

  const tamper = await POST("/api/pos/checkout", {
    warehouseId,
    items: [{ productId, productName: "E2E Widget v2", sku: uniq, quantity: 1, unitPrice: CENTS_UNIT, costPrice: CENTS_COST, discountAmount: 0, taxRate: 0, taxAmount: 0, total: 1 }],
    subtotal: CENTS_UNIT, taxAmount: 0, discountAmount: 0, total: 1,
    paymentMethod: "cash", amountPaid: 1, changeDue: 0, loyaltyPointsRedeemed: 0,
  });
  ok("forged total rejected by tamper guard", tamper.status >= 400 && tamper.status < 500, JSON.stringify(tamper.json?.error ?? tamper.status).slice(0, 120));

  const underpay = await POST("/api/pos/checkout", {
    warehouseId,
    items: [{ productId, productName: "E2E Widget v2", sku: uniq, quantity: 1, unitPrice: CENTS_UNIT, costPrice: CENTS_COST, discountAmount: 0, taxRate: 5, taxAmount: 7500, total: 157500 }],
    subtotal: CENTS_UNIT, taxAmount: 7500, discountAmount: 0, total: 157500,
    paymentMethod: "cash", amountPaid: 100, changeDue: 0, loyaltyPointsRedeemed: 0,
  });
  ok("underpayment without customer rejected", underpay.status >= 400 && underpay.status < 500, JSON.stringify(underpay.json?.error ?? underpay.status).slice(0, 120));
}

/* ── khata: credit sale → dues → settlement ────────────────── */
section = "khata";
let customerId;
{
  const cust = await POST("/api/customers", { name: "E2E Khata", phone: "+92 300 1112223", email: `e2e-khata-${Date.now()}@c.example` });
  customerId = cust.json?.customer?.id ?? cust.json?.id;
  ok("customer create", cust.status === 201 && !!customerId, JSON.stringify(cust.json?.error ?? "").slice(0, 120));

  // Short payment with a customer → 157500 − 50000 = 107500 khata due
  const credit = await POST("/api/pos/checkout", {
    warehouseId, customerId,
    items: [{ productId, productName: "E2E Widget v2", sku: uniq, quantity: 1, unitPrice: CENTS_UNIT, costPrice: CENTS_COST, discountAmount: 0, taxRate: 5, taxAmount: 7500, total: 157500 }],
    subtotal: CENTS_UNIT, taxAmount: 7500, discountAmount: 0, total: 157500,
    paymentMethod: "cash", amountPaid: 50000, changeDue: 0, loyaltyPointsRedeemed: 0,
  });
  ok("credit sale accepted", credit.status === 201 || credit.status === 200, JSON.stringify(credit.json?.error ?? credit.status).slice(0, 140));

  const detail = (await GET(`/api/customers/${customerId}`)).json;
  const balance = detail?.customer?.outstandingBalance ?? detail?.outstandingBalance;
  ok("dues recorded exactly 107500", balance === 107500, `balance=${balance}`);

  const pay = await POST(`/api/customers/${customerId}/payments`, { amount: 50000, method: "cash", notes: "e2e partial settle" });
  ok("payment against dues accepted", pay.status === 200 || pay.status === 201, JSON.stringify(pay.json?.error ?? pay.status).slice(0, 120));

  const detail2 = (await GET(`/api/customers/${customerId}`)).json;
  const balance2 = detail2?.customer?.outstandingBalance ?? detail2?.outstandingBalance;
  ok("balance decremented to 57500", balance2 === 57500, `balance=${balance2}`);

  ok("customer statement renders", (await GET(`/api/customers/${customerId}/statement`)).status === 200);
}

/* ── orders + refunds (stats-only refunds API) ─────────────── */
section = "orders-refunds";
{
  const list = (await GET("/api/orders?page=1")).json;
  ok("orders list", Array.isArray(list?.orders) && list.orders.length > 0, `${list?.orders?.length} rows`);
  const br = await POST("/api/orders/bulk-refund", { orderIds: [orderId], reason: "e2e sweep refund" });
  ok("bulk-refund accepted", br.status === 200 || br.status === 201, JSON.stringify(br.json?.error ?? br.status).slice(0, 140));
  const stats = (await GET("/api/refunds")).json;
  ok("refund stats shape (total/sum/average/trend)", typeof stats?.total === "number" && typeof stats?.sumTotal === "number" && Array.isArray(stats?.monthlyTrend), `total=${stats?.total}`);
  const refundedOrders = (await GET("/api/orders?page=1&status=refunded")).json;
  ok("refunded orders visible via orders API", Array.isArray(refundedOrders?.orders), `${refundedOrders?.orders?.length ?? "?"} rows`);
}

/* ── inventory operations ──────────────────────────────────── */
section = "inventory";
{
  ok("inventory list", (await GET("/api/inventory?page=1")).status === 200);
  ok("movements for product", (await GET(`/api/inventory/movements?productId=${productId}&pageSize=30`)).status === 200);

  const stockBefore = (await GET(`/api/products/${productId}`)).json?.product?.totalStock;
  const adj = await POST("/api/inventory/adjust", { productId, warehouseId, quantity: 5, type: "count", notes: "e2e recount" });
  ok("stock adjust accepted", adj.status === 200 || adj.status === 201, JSON.stringify(adj.json?.error ?? adj.status).slice(0, 120));
  const stockAfter = (await GET(`/api/products/${productId}`)).json?.product?.totalStock;
  ok("adjust moved stock +5", stockAfter - stockBefore === 5, `${stockBefore} → ${stockAfter}`);

  const whs = (await GET("/api/warehouses")).json;
  const whArr = whs?.warehouses ?? whs;
  const otherWh = whArr.find((w) => w.id !== warehouseId);
  if (otherWh) {
    const tr = await POST("/api/inventory/transfer", { fromWarehouseId: warehouseId, toWarehouseId: otherWh.id, items: [{ productId, quantity: 1 }], notes: "e2e" });
    ok("stock transfer accepted", tr.status === 200 || tr.status === 201, JSON.stringify(tr.json?.error ?? tr.status).slice(0, 120));
  } else {
    ok("transfer skipped (single warehouse)", true);
  }

  const resv = await POST("/api/inventory/reserve", { productId, warehouseId, quantity: 1, referenceId: "e2e-cart-1" });
  ok("reservation accepted", resv.status === 200 || resv.status === 201, JSON.stringify(resv.json?.error ?? resv.status).slice(0, 120));
  const cleanup = await POST("/api/inventory/reserve/cleanup", {});
  ok("reservation cleanup runs", cleanup.status === 200 || cleanup.status === 201, `status ${cleanup.status}`);

  ok("inventory report", (await GET("/api/reports/inventory")).status === 200);
}

/* ── purchasing: supplier + PO with exact math ─────────────── */
section = "purchasing";
let supplierId, poId;
{
  const list = (await GET("/api/suppliers?page=1&sort=name.asc")).json;
  ok("suppliers list (regression fix)", Array.isArray(list?.suppliers) && list.suppliers.length > 0, `${list?.suppliers?.length} rows`);

  const sup = await POST("/api/suppliers", { name: "E2E Supplier " + Date.now(), email: `e2e-${Date.now()}@sup.example`, paymentTerms: 15 });
  supplierId = sup.json?.supplier?.id ?? sup.json?.id;
  ok("supplier create", sup.status === 201 && !!supplierId, JSON.stringify(sup.json?.error ?? "").slice(0, 120));
  const one = (await GET(`/api/suppliers/${supplierId}`)).json;
  ok("supplier detail + stats", one?.supplier?.stats && typeof one.supplier.stats.totalSpent === "number");

  // PO line: 10 × 800 = 8000, tax 5% = 400, shipping 100 → total 8500
  const po = await POST("/api/purchase-orders", {
    supplierId, warehouseId, shippingCost: 100, notes: "e2e",
    items: [{ productId, productName: "E2E Widget v2", sku: uniq, quantity: 10, unitCost: 800, taxRate: 5 }],
  });
  poId = po.json?.order?.id ?? po.json?.purchaseOrder?.id ?? po.json?.id;
  ok("PO create", po.status === 201 && !!poId, JSON.stringify(po.json?.error ?? po.status).slice(0, 140));
  if (poId) {
    const poGet = (await GET(`/api/purchase-orders/${poId}`)).json;
    const poTotal = poGet?.order?.total ?? poGet?.purchaseOrder?.total ?? poGet?.total;
    ok("PO total math exact (8500)", poTotal === 8500, `total=${poTotal}`);
    const toPending = await PUT(`/api/purchase-orders/${poId}`, { status: "pending" });
    ok("PO draft→pending", toPending.status === 200, JSON.stringify(toPending.json?.error ?? toPending.status).slice(0, 100));
    const toOrdered = await PUT(`/api/purchase-orders/${poId}`, { status: "ordered" });
    ok("PO pending→ordered", toOrdered.status === 200, JSON.stringify(toOrdered.json?.error ?? toOrdered.status).slice(0, 100));
  }
  ok("receivables report", (await GET("/api/reports/receivables")).status === 200);
}

/* ── users + audit ─────────────────────────────────────────── */
section = "users-audit";
let userId;
{
  const list = (await GET("/api/users?page=1")).json;
  ok("users list", Array.isArray(list?.users), `${list?.users?.length ?? "?"} rows`);
  const u = await POST("/api/users", { name: "E2E Cashier", email: `e2e-${Date.now()}@pos.example`, password: "Password1!", role: "cashier" });
  userId = u.json?.user?.id ?? u.json?.id;
  ok("user create", u.status === 201 && !!userId, JSON.stringify(u.json?.error ?? "").slice(0, 120));
  if (userId) ok("user deactivate", (await PUT(`/api/users/${userId}`, { isActive: false })).status === 200);
  const audit = (await GET("/api/audit-log?page=1")).json;
  ok("audit log has entries", Array.isArray(audit?.logs) && audit.logs.length > 0, `${audit?.logs?.length} rows`);
  ok("activity feed", (await GET("/api/activity")).status === 200);
}

/* ── dashboard + system ────────────────────────────────────── */
section = "dashboard-system";
{
  ok("dashboard stats", (await GET("/api/dashboard")).status === 200);
  ok("alerts", (await GET("/api/alerts")).status === 200);
  ok("low-stock notifications", (await GET("/api/notifications/low-stock")).status === 200);
  ok("system jobs", (await GET("/api/system/jobs")).status === 200);
  const health = (await GET("/api/health")).json;
  ok("health db up", health?.db === "up");
  ok("printer profiles", (await GET("/api/printer-profiles")).status === 200);
  ok("scan settings", (await GET("/api/scan-settings")).status === 200);
  ok("palette recents", (await GET("/api/palette-recents")).status === 200);
  ok("notifications log", (await GET("/api/notifications/log")).status === 200);
}

/* ── cleanup (soft-delete paths) ───────────────────────────── */
section = "cleanup";
{
  if (productId) ok("product delete", (await DEL(`/api/products/${productId}`)).status === 200);
  if (customerId) ok("customer delete", (await DEL(`/api/customers/${customerId}`)).status === 200);
  if (supplierId) {
    const s = (await DEL(`/api/suppliers/${supplierId}`)).status;
    ok("supplier delete (soft or blocked-with-reason)", s === 200 || s === 400 || s === 409, `status ${s}`);
  }
  if (userId) {
    const s = (await DEL(`/api/users/${userId}`)).status;
    ok("user delete (soft or blocked-with-reason)", s === 200 || s === 400 || s === 409, `status ${s}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n════════ SWEEP: ${results.length - failed.length}/${results.length} passed ════════`);
for (const f of failed) console.log(`FAIL [${f.section}] ${f.name} — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
