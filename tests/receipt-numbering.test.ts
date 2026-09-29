/* ═══════════════════════════════════════════════════════════════
   RECEIPT NUMBERING — unit tests
   Locks the gap-free, per-terminal, no-reuse allocation rule:
   - per-terminal isolation (T1 and T2 count independently)
   - no reuse after a void (max-based, not count-based)
   - format stability and parse round-trip
   Run: npx tsx --test tests/receipt-numbering.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateReceiptNo,
  formatReceiptNo,
  parseReceiptSeq,
  resolveTerminalId,
} from "@/lib/receipt-number";

/** Minimal in-memory tx double standing in for the Prisma tx client. */
function makeTx(rows: Array<{ terminalId: string; receiptNo: string }>) {
  return {
    receipt: {
      findFirst: async (args: { where: { terminalId: string } }) => {
        const list = rows
          .filter((r) => r.terminalId === args.where.terminalId)
          .map((r) => r.receiptNo)
          .sort();
        return list.length ? { receiptNo: list[list.length - 1] } : null;
      },
      count: async (args: { where: { terminalId: string } }) =>
        rows.filter((r) => r.terminalId === args.where.terminalId).length,
    },
  };
}

test("formatReceiptNo pads to six digits", () => {
  assert.equal(formatReceiptNo("T1", 1), "R-T1-000001");
  assert.equal(formatReceiptNo("T2", 123456), "R-T2-123456");
});

test("parseReceiptSeq round-trips and rejects foreign formats", () => {
  assert.equal(parseReceiptSeq("R-T1-000042"), 42);
  assert.equal(parseReceiptSeq("POS-20260929-0007"), null);
  assert.equal(parseReceiptSeq("garbage"), null);
});

test("resolveTerminalId defaults to T1 and caps length", () => {
  assert.equal(resolveTerminalId(undefined), "T1");
  assert.equal(resolveTerminalId(""), "T1");
  assert.equal(resolveTerminalId("  "), "T1");
  assert.equal(resolveTerminalId("Front-Counter"), "Front-Counter");
  assert.equal(resolveTerminalId("x".repeat(100)).length, 40);
});

test("allocation is per-terminal: T2 does not continue T1's series", async () => {
  const tx = makeTx([
    { terminalId: "T1", receiptNo: "R-T1-000001" },
    { terminalId: "T1", receiptNo: "R-T1-000002" },
  ]);
  assert.equal(await allocateReceiptNo(tx as never, "T1"), "R-T1-000003");
  assert.equal(await allocateReceiptNo(tx as never, "T2"), "R-T2-000001");
});

test("no reuse after a void: max-based, not count-based", async () => {
  // T1 issued 000001..000005; 000004's sale was voided and its receipt
  // row deleted would be a violation — but if a legacy import left a
  // gap (1,2,3,5 present, 4 missing), the next number must be 6, not 4.
  const tx = makeTx([
    { terminalId: "T1", receiptNo: "R-T1-000001" },
    { terminalId: "T1", receiptNo: "R-T1-000002" },
    { terminalId: "T1", receiptNo: "R-T1-000003" },
    { terminalId: "T1", receiptNo: "R-T1-000005" },
  ]);
  assert.equal(await allocateReceiptNo(tx as never, "T1"), "R-T1-000006");
});

test("legacy series without the R- prefix fall back to count", async () => {
  const tx = makeTx([
    { terminalId: "T1", receiptNo: "LEGACY-77" },
    { terminalId: "T1", receiptNo: "LEGACY-78" },
  ]);
  // parse fails → seq 0; count 2 → next is 3, UNIQUE guard still holds.
  assert.equal(await allocateReceiptNo(tx as never, "T1"), "R-T1-000003");
});

test("empty series starts at 1", async () => {
  const tx = makeTx([]);
  assert.equal(await allocateReceiptNo(tx as never, "T9"), "R-T9-000001");
});
