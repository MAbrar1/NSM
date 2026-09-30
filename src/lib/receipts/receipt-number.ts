/* ═══════════════════════════════════════════════════════════════
   RECEIPT NUMBER ALLOCATOR
   Gap-free, per-terminal, no-reuse receipt numbers, allocated
   INSIDE the sale transaction so a rolled-back sale can never burn
   a number (that is what makes the series gap-free).

   How it works:
   - The sequence state is the row count of receipts for the terminal
     (a MAX()-free design: counting is a single indexed scan and the
     UNIQUE constraint on Receipt.receiptNo is the real guard).
   - `tx` is the Prisma transaction client the caller is already
     running in — allocation participates in the sale's atomicity.
   - On a concurrent collision (two terminals with the same id racing,
     or a manual retry), the caller's retryOnUniqueConflict loop
     re-counts and retries.
   - Continuity: an existing series (e.g. imported or pre-Phase-2
     receipts) continues from its highest number — allocation seeds
     from `maxExistingNo` when provided, else counts.
   ═══════════════════════════════════════════════════════════════ */

/** Terminal id for this register. Overridable per request later. */
export function resolveTerminalId(requested?: string | null): string {
  const id = (requested ?? "").trim();
  if (id) return id.slice(0, 40);
  // Default single-register terminal. Stable, never empty.
  return "T1";
}

/**
 * Format a receipt number: R-<terminal>-<seq 6 digits>.
 * e.g. R-T1-000042
 */
export function formatReceiptNo(terminalId: string, seq: number): string {
  return `R-${terminalId}-${String(seq).padStart(6, "0")}`;
}

/** Parse the sequence out of an existing receipt number (null if foreign format). */
export function parseReceiptSeq(receiptNo: string): number | null {
  const m = receiptNo.match(/R-[^-]+-(\d{6,})$/);
  return m ? Number(m[1]) : null;
}

/**
 * Allocate the next receipt number for a terminal inside `tx`.
 * Continues an existing series: seeds from the highest existing
 * sequence for this terminal when the table is non-empty (count-based
 * allocation would reuse numbers after voids; max-based does not).
 */
/** The subset of the Prisma transaction client the allocator needs.
 *  Structural (not the concrete Prisma type) so tests can pass a
 *  lightweight in-memory double. */
export interface ReceiptNumberTx {
  receipt: {
    findFirst: (args: {
      where: { terminalId: string };
      orderBy: { receiptNo: "desc" };
      select: { receiptNo: true };
    }) => Promise<{ receiptNo: string } | null>;
    count: (args: { where: { terminalId: string } }) => Promise<number>;
  };
}

export async function allocateReceiptNo(
  tx: ReceiptNumberTx,
  terminalId: string
): Promise<string> {
  // Highest existing number for this terminal (no reuse, ever).
  const last = await tx.receipt.findFirst({
    where: { terminalId },
    orderBy: { receiptNo: "desc" },
    select: { receiptNo: true },
  });
  const lastSeq = last?.receiptNo ? parseReceiptSeq(last.receiptNo) : null;

  // Legacy/imported series may not parse — fall back to a count so we
  // still never collide (UNIQUE constraint remains the final guard).
  const count = await tx.receipt.count({ where: { terminalId } });

  const seq = Math.max(lastSeq ?? 0, count) + 1;
  return formatReceiptNo(terminalId, seq);
}
