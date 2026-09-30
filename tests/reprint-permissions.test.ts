/* ═══════════════════════════════════════════════════════════════
   REPRINT RULES — integration tests (real SQLite via Prisma)
   Locks:
   - PRINT stays PRINT on retry of a failed first print; only a
     successful print turns the next attempt into REPRINT
   - DUPLICATE count = successful prints − 1
   - reprint permission: cashier own+window, manager any, void blocked
   - the print log is append-only (UPDATE/DELETE blocked by trigger)
   Run: npx tsx --test tests/reprint-permissions.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./integration/env";
import { setupTestDb, teardownTestDb, cleanTables, db } from "./integration/db";
import {
  canReprint,
  resolvePrintAction,
  reprintCount,
  writePrintLog,
  verifyBeforeReprint,
} from "@/lib/receipt-print";
import { buildReceiptSnapshot, computeReceiptContentHash, RECEIPT_TEMPLATE_VERSION } from "@/lib/receipt-snapshot";

let harness: Awaited<ReturnType<typeof setupTestDb>> | null = null;
before(async () => {
  harness = await setupTestDb();
});
after(async () => {
  await teardownTestDb();
  harness = null;
});
beforeEach(async () => {
  await cleanTables();
});

let receiptId = "";
let cashierId = "";
let managerId = "";
let snapshot: ReturnType<typeof buildReceiptSnapshot>;
let contentHash: string;

beforeEach(async () => {
  const cashier = await db.user.create({
    data: { email: "c@t.local", name: "Cashier", password: "x", role: "cashier" },
  });
  cashierId = cashier.id;
  const manager = await db.user.create({
    data: { email: "m@t.local", name: "Manager", password: "x", role: "manager" },
  });
  managerId = manager.id;

  snapshot = buildReceiptSnapshot({
    receiptNo: "R-T1-000001",
    terminalId: "T1",
    issuedAt: new Date(),
    language: "en",
    order: {
      subtotal: 500, taxAmount: 0, discountAmount: 0, total: 500,
      paidAmount: 500, changeAmount: 0, dueAmount: 0, paymentStatus: "paid",
      loyaltyRedeemed: 0, loyaltyPointsRedeemed: 0,
      items: [{ productName: "Coffee", sku: "S1", quantity: 1, unit: "pcs", unitPrice: 500, discountAmount: 0, taxRate: 0, taxAmount: 0, total: 500 }],
    },
    cashierName: "Cashier",
    customerName: null,
    customerLoyaltyBalance: 0,
    settings: { storeName: "NSM", storeAddress: null, storePhone: null, receiptHeader: null, receiptFooter: null, receiptQrPayment: null, receiptUrduDigits: false },
  });
  contentHash = computeReceiptContentHash(snapshot, RECEIPT_TEMPLATE_VERSION);

  const wh = await db.warehouse.create({ data: { name: "Main", code: "MAIN", isDefault: true } });
  const customer = await db.customer.create({ data: { name: "Walk-in" } });
  const order = await db.order.create({
    data: { orderNumber: "POS-T-0001", userId: cashierId, warehouseId: wh.id, customerId: customer.id, status: "completed", total: 500 },
  });
  const receipt = await db.receipt.create({
    data: {
      receiptNo: "R-T1-000001",
      terminalId: "T1",
      orderId: order.id,
      templateVersion: RECEIPT_TEMPLATE_VERSION,
      language: "en",
      contentHash,
      snapshotJson: JSON.stringify(snapshot),
    },
  });
  receiptId = receipt.id;
});

const actor = (userId: string, role: "cashier" | "manager") => ({ userId, role });
const receiptRef = () => ({ userId: cashierId, issuedAt: new Date(), status: "ISSUED" });

test("first print is PRINT; failed retry stays PRINT; success flips to REPRINT", async () => {
  assert.equal(await resolvePrintAction(receiptId), "PRINT");
  await writePrintLog({ receiptId, action: "PRINT", result: "FAILED", userId: cashierId, errorCode: "OFFLINE" });
  assert.equal(await resolvePrintAction(receiptId), "PRINT", "retry of failed first print stays PRINT");
  await writePrintLog({ receiptId, action: "PRINT", result: "OK", userId: cashierId });
  assert.equal(await resolvePrintAction(receiptId), "REPRINT", "after a success the next print is a REPRINT");
  assert.equal(await reprintCount(receiptId), 0, "one successful print = the ORIGINAL, no duplicates yet");
  await writePrintLog({ receiptId, action: "REPRINT", result: "OK", userId: managerId, reason: "customer lost copy" });
  assert.equal(await reprintCount(receiptId), 1, "first duplicate");
});

test("cashier: own receipt within window allowed, others blocked", () => {
  assert.deepEqual(canReprint(actor(cashierId, "cashier"), receiptRef()), { allowed: true });
  const other = canReprint(actor("someone-else", "cashier"), receiptRef());
  assert.equal(other.allowed, false);
});

test("manager: any receipt; window does not apply", () => {
  const old = { userId: cashierId, issuedAt: new Date(Date.now() - 90 * 3600_000), status: "ISSUED" };
  assert.deepEqual(canReprint(actor(managerId, "manager"), old), { allowed: true });
  const cashierOld = canReprint(actor(cashierId, "cashier"), old);
  assert.equal(cashierOld.allowed, false, "cashier blocked outside the window");
});

test("voided receipts cannot be reprinted", () => {
  const voided = { userId: cashierId, issuedAt: new Date(), status: "VOID" };
  assert.equal(canReprint(actor(managerId, "manager"), voided).allowed, false);
});

test("hash gate: tampered snapshot blocks reprint with audit entry", async () => {
  const tampered = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  tampered["total"] = 999_999;
  const bad = await db.receipt.create({
    data: {
      receiptNo: "R-T1-000002",
      terminalId: "T1",
      orderId: (await db.order.create({
        data: { orderNumber: "POS-T-0002", userId: cashierId, warehouseId: (await db.warehouse.findFirst())!.id, status: "completed", total: 500 },
      })).id,
      templateVersion: RECEIPT_TEMPLATE_VERSION,
      language: "en",
      contentHash,
      snapshotJson: JSON.stringify(tampered),
    },
  });
  const result = await verifyBeforeReprint(
    { id: bad.id, receiptNo: bad.receiptNo, snapshotJson: bad.snapshotJson, templateVersion: bad.templateVersion, contentHash: bad.contentHash },
    actor(managerId, "manager")
  );
  assert.equal(result.ok, false);
  const audits = await db.auditLog.findMany({ where: { entityId: bad.id } });
  assert.ok(audits.some((a) => JSON.stringify(a.newValues).includes("content_hash_mismatch")));
});

test("print log is append-only: UPDATE and DELETE are DB-blocked", async () => {
  await writePrintLog({ receiptId, action: "PRINT", result: "OK", userId: cashierId });
  const row = await db.receiptPrintLog.findFirst({ where: { receiptId } });
  assert.ok(row);
  // Prisma surfaces the trigger's RAISE(ABORT) as a P2010/P2025-style
  // raw error; the assertion is that the write is REJECTED at all,
  // with the trigger message carried anywhere in the error chain.
  await assert.rejects(
    () => db.receiptPrintLog.update({ where: { id: row!.id }, data: { result: "FAILED" } })
  );
  await assert.rejects(
    () => db.receiptPrintLog.delete({ where: { id: row!.id } })
  );
});
