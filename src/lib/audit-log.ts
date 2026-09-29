import { db } from "@/lib/db";

/* ═══════════════════════════════════════════════════════════════
   AUDIT LOG UTILITY
   Centralized logging for all significant operations.
   Records who did what, when, and what changed.
   ═══════════════════════════════════════════════════════════════ */

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "login"
  | "logout"
  | "refund"
  | "stock_adjust"
  | "stock_transfer"
  | "checkout"
  | "customer_payment"
  | "status_change";

export type AuditEntity =
  | "product"
  | "order"
  | "customer"
  | "supplier"
  | "warehouse"
  | "user"
  | "settings"
  | "category"
  | "brand"
  | "purchase_order"
  | "stock_transfer"
  | "stock_level";

interface AuditLogEntry {
  userId: string;
  action: AuditAction;
  entity: AuditEntity;
  entityId?: string;
  entityName?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Log an audit event. Failures are silently swallowed — audit logging
 * should never block the main operation.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        entityName: entry.entityName,
        oldValues: entry.oldValues ? JSON.stringify(entry.oldValues) : null,
        newValues: entry.newValues ? JSON.stringify(entry.newValues) : null,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      },
    });
  } catch (error) {
    // Audit failures must not break the main operation
    console.error("[AUDIT_LOG_ERROR]", error);
  }
}

/**
 * Helper to compute the diff between old and new values.
 * Only includes fields that actually changed.
 */
export function computeDiff(
  oldValues: Record<string, unknown>,
  newValues: Record<string, unknown>
): { old: Record<string, unknown>; new: Record<string, unknown> } {
  const old: Record<string, unknown> = {};
  const newVals: Record<string, unknown> = {};

  const allKeys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  for (const key of allKeys) {
    const oldVal = oldValues[key];
    const newVal = newValues[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      if (oldVal !== undefined) old[key] = oldVal;
      if (newVal !== undefined) newVals[key] = newVal;
    }
  }

  return { old, new: newVals };
}
