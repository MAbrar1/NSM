/* ═══════════════════════════════════════════════════════════════
   RECEIPT PRINT — domain rules for printing and reprinting.

   - The receipt row NEVER changes: printing writes only to the
     append-only ReceiptPrintLog (DB trigger blocks UPDATE/DELETE).
   - PRINT vs REPRINT: a retry of a failed first print stays action
     PRINT; only after a successful PRINT is any further print a
     REPRINT. The rule reads the log, never a mutable counter.
   - Reprints must verify content_hash (canonical snapshot +
     template_version) BEFORE rendering; a mismatch blocks the
     reprint and writes an audit entry — history is not renderable
     if it was tampered with.
   - Reprint permission: cashiers may reprint their OWN receipts from
     the current/last shift within a configurable window; managers+
     may reprint any receipt. A reason string is required for every
     reprint and lands in the log.
   - Reprints render "DUPLICATE COPY" + count; fiscal data shown is
     the LATEST fiscal record (the receipts row itself is frozen).
   ═══════════════════════════════════════════════════════════════ */

import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit-log";
import {
  verifyReceiptContentHash,
  type ReceiptSnapshot,
} from "@/lib/receipt-snapshot";
import { hasPermission, type Role } from "@/lib/rbac";

/** Reprint window for own-receipt reprints (hours). Configurable via
 *  ScanSettings-style singleton later; the default is one shift. */
export const REPRINT_OWN_WINDOW_HOURS = 12;

/** What the reprint permission check needs about the actor. */
export interface ReprintActor {
  userId: string;
  role: Role;
}

export type ReprintDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether `actor` may reprint `receipt`.
 * `receipt.userId` is the cashier who made the sale.
 */
export function canReprint(
  actor: ReprintActor,
  receipt: { userId: string; issuedAt: Date; status: string },
  now: Date = new Date()
): ReprintDecision {
  if (receipt.status === "VOID") {
    return { allowed: false, reason: "Voided receipts cannot be reprinted" };
  }
  if (hasPermission(actor.role, "receipts:reprint_any")) {
    return { allowed: true };
  }
  if (!hasPermission(actor.role, "receipts:reprint_own")) {
    return { allowed: false, reason: "You do not have permission to reprint receipts" };
  }
  if (receipt.userId !== actor.userId) {
    return { allowed: false, reason: "You can only reprint your own receipts" };
  }
  const windowMs = REPRINT_OWN_WINDOW_HOURS * 3600_000;
  if (now.getTime() - receipt.issuedAt.getTime() > windowMs) {
    return {
      allowed: false,
      reason: `Own receipts can be reprinted only within ${REPRINT_OWN_WINDOW_HOURS}h of issue — ask a manager`,
    };
  }
  return { allowed: true };
}

/**
 * Decide the log action for this attempt: a retry of a failed first
 * print stays PRINT; only after a successful PRINT is it a REPRINT.
 */
export async function resolvePrintAction(receiptId: string): Promise<"PRINT" | "REPRINT"> {
  const last = await db.receiptPrintLog.findFirst({
    where: { receiptId, action: { in: ["PRINT", "REPRINT"] } },
    orderBy: { createdAt: "desc" },
    select: { action: true, result: true },
  });
  if (!last) return "PRINT";
  // A successful print of any kind already happened → the next is a reprint.
  if (last.result === "OK") return "REPRINT";
  // The last attempt failed: a retry of a failed PRINT stays PRINT,
  // a retry of a failed REPRINT stays REPRINT.
  return last.action === "REPRINT" ? "REPRINT" : "PRINT";
}

/** How many successful prints have happened (the DUPLICATE COPY counter). */
export async function reprintCount(receiptId: string): Promise<number> {
  const okPrints = await db.receiptPrintLog.count({
    where: { receiptId, action: { in: ["PRINT", "REPRINT"] }, result: "OK" },
  });
  return Math.max(0, okPrints - 1); // first successful print is the ORIGINAL
}

/** The log row every attempt must write (append-only). */
export async function writePrintLog(entry: {
  receiptId: string;
  action: "PRINT" | "REPRINT" | "EMAIL" | "WHATSAPP" | "PDF";
  result: "OK" | "FAILED";
  errorCode?: string | null;
  userId: string;
  printerProfileId?: string | null;
  terminalId?: string | null;
  reason?: string | null;
}): Promise<void> {
  await db.receiptPrintLog.create({
    data: {
      receiptId: entry.receiptId,
      action: entry.action,
      result: entry.result,
      errorCode: entry.errorCode ?? null,
      userId: entry.userId,
      printerProfileId: entry.printerProfileId ?? null,
      terminalId: entry.terminalId ?? null,
      reason: entry.reason ?? null,
    },
  });
}

/**
 * Verify a receipt's snapshot against its stored content hash.
 * On mismatch: audit entry + blocked flag. The caller refuses to
 * render when blocked=true.
 */
export async function verifyBeforeReprint(receipt: {
  id: string;
  receiptNo: string;
  snapshotJson: string;
  templateVersion: number;
  contentHash: string;
}, actor: ReprintActor): Promise<{ ok: boolean; snapshot: ReceiptSnapshot | null }> {
  let snapshot: ReceiptSnapshot;
  try {
    snapshot = JSON.parse(receipt.snapshotJson) as ReceiptSnapshot;
  } catch {
    await logAudit({
      userId: actor.userId,
      action: "status_change",
      entity: "order",
      entityId: receipt.id,
      entityName: receipt.receiptNo,
      newValues: { event: "reprint_blocked", reason: "snapshot_unparseable" },
    });
    return { ok: false, snapshot: null };
  }
  const ok = verifyReceiptContentHash(snapshot, receipt.templateVersion, receipt.contentHash);
  if (!ok) {
    await logAudit({
      userId: actor.userId,
      action: "status_change",
      entity: "order",
      entityId: receipt.id,
      entityName: receipt.receiptNo,
      newValues: { event: "reprint_blocked", reason: "content_hash_mismatch" },
    });
  }
  return { ok, snapshot };
}
