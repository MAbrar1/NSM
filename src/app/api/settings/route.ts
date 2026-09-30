import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { storeSettingsSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   SETTINGS API
   GET  /api/settings — Read store settings (singleton)
   PUT  /api/settings — Update store settings (requires settings:edit)
   PUT accepts partial bodies (e.g. receipt-only page) and merges
   them with the currently persisted values.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Placeholder returned in place of stored secrets (webhookSecret /
 * smtpPassword) so the settings screen can tell "configured" from
 * "empty" without ever sending the real value to the browser. When the
 * client saves without changing the field, PUT sees this sentinel and
 * keeps the existing secret; an empty string still clears it.
 *
 * NOT exported: a route file may only export HTTP handlers + route
 * config — any other export fails `next build`.
 */
const SECRET_MASK = "********";

const DEFAULTS = {
  storeName: "My Store",
  storeAddress: "",
  storePhone: "",
  storeEmail: "",
  taxRate: 0,
  taxInclusive: false,
  currency: "USD",
  receiptHeader: "",
  receiptFooter: "",
  receiptQrPayment: "",
  receiptUrduDigits: false,
  lowStockThreshold: 5,
  allowPublicRegistration: false,
  refundReasonPresets: "",
  lowStockSchedulerEnabled: true,
  lowStockCooldownHours: 6,
  lowStockMinQuantity: null,
  lowStockRunningLowAlerts: false,
  // Notification channel config. These MUST be listed here (and in the
  // `existing` merge below): this route merges a partial body over the current
  // row, so anything missing falls back to the Zod default and is written back
  // — which silently reset a store's prefs every time the Receipts settings
  // page saved its own three fields.
  webhookUrl: "",
  webhookSecret: "",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPassword: "",
  smtpFromEmail: "",
  smtpFromName: "",
  smtpUseTls: true,
  lowStockNotifyWebhook: false,
  lowStockNotifyEmail: false,
  lowStockNotifyAdmins: true,
};

export async function GET() {
  try {
    // Settings include SMTP credentials, webhook URLs and registration
    // policy — reading them requires the settings:view permission, not
    // just a session (previously any authenticated user could read it).
    const { response } = await requirePermission("settings:view");
    if (response) return response;

    let settings = await db.storeSettings.findUnique({
      where: { id: "singleton" },
    });

    // Upsert singleton if it doesn't exist yet
    if (!settings) {
      settings = await db.storeSettings.create({ data: { id: "singleton" } });
    }

    // Never ship stored secrets to the browser — replace them with a mask so
    // the UI still knows they're configured without exposing the value.
    const safe = {
      ...settings,
      webhookSecret: settings.webhookSecret ? SECRET_MASK : null,
      smtpPassword: settings.smtpPassword ? SECRET_MASK : null,
    };

    return NextResponse.json({ settings: safe });
  } catch (error) {
    console.error("[SETTINGS_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("settings:edit");
    if (response) return response;

    const body = await request.json();
    if (!body || typeof body !== "object") {
      return apiError("Invalid request body", 400);
    }

    // Load current values so partial updates never clobber omitted fields
    const existing = await db.storeSettings.findUnique({
      where: { id: "singleton" },
    });

    // Every persisted field is repeated from the current row before the body is
    // merged, so a partial PUT (the Receipts page sends 3 fields) preserves the
    // rest instead of resetting them to the schema defaults.
    const merged = {
      ...DEFAULTS,
      ...(existing
        ? {
            storeName: existing.storeName,
            storeAddress: existing.storeAddress ?? "",
            storePhone: existing.storePhone ?? "",
            storeEmail: existing.storeEmail ?? "",
            taxRate: existing.taxRate,
            taxInclusive: existing.taxInclusive,
            currency: existing.currency,
            receiptHeader: existing.receiptHeader ?? "",
            receiptFooter: existing.receiptFooter ?? "",
            receiptQrPayment: existing.receiptQrPayment ?? "",
            receiptUrduDigits: existing.receiptUrduDigits,
            lowStockThreshold: existing.lowStockThreshold,
            allowPublicRegistration: existing.allowPublicRegistration,
            refundReasonPresets: existing.refundReasonPresets ?? "",
            lowStockSchedulerEnabled: existing.lowStockSchedulerEnabled,
            lowStockCooldownHours: existing.lowStockCooldownHours,
            lowStockMinQuantity: existing.lowStockMinQuantity,
            lowStockRunningLowAlerts: existing.lowStockRunningLowAlerts,
            webhookUrl: existing.webhookUrl ?? "",
            webhookSecret: existing.webhookSecret ?? "",
            smtpHost: existing.smtpHost ?? "",
            smtpPort: existing.smtpPort,
            smtpUser: existing.smtpUser ?? "",
            smtpPassword: existing.smtpPassword ?? "",
            smtpFromEmail: existing.smtpFromEmail ?? "",
            smtpFromName: existing.smtpFromName ?? "",
            smtpUseTls: existing.smtpUseTls,
            lowStockNotifyWebhook: existing.lowStockNotifyWebhook,
            lowStockNotifyEmail: existing.lowStockNotifyEmail,
            lowStockNotifyAdmins: existing.lowStockNotifyAdmins,
          }
        : {}),
      ...body,
    };

    const result = storeSettingsSchema.safeParse(merged);
    if (!result.success) {
      return validationError(result.error);
    }

    const data = result.data;

    // Settings carry secrets (webhook/smtp credentials) — keep the values
    // out of the audit trail and only note which fields changed.
    const sensitive = new Set(["webhookSecret", "smtpPassword"]);
    const changedFields = Object.keys(body)
      .filter((k) => !sensitive.has(k))
      .filter((k) => {
        const oldVal = existing?.[k as keyof typeof existing] ?? DEFAULTS[k as keyof typeof DEFAULTS];
        return JSON.stringify(oldVal) !== JSON.stringify(body[k]);
      });

    // A masked secret in the payload means "leave it unchanged"; anything
    // else (including "") is written through so fields can still be cleared.
    const webhookSecret =
      data.webhookSecret === SECRET_MASK
        ? existing?.webhookSecret ?? null
        : data.webhookSecret || null;
    const smtpPassword =
      data.smtpPassword === SECRET_MASK
        ? existing?.smtpPassword ?? null
        : data.smtpPassword || null;

    const settings = await db.storeSettings.upsert({
      where: { id: "singleton" },
      update: {
        storeName: data.storeName,
        storeAddress: data.storeAddress || null,
        storePhone: data.storePhone || null,
        storeEmail: data.storeEmail || null,
        taxRate: data.taxRate,
        taxInclusive: data.taxInclusive,
        currency: data.currency,
        receiptHeader: data.receiptHeader || null,
        receiptFooter: data.receiptFooter || null,
        receiptQrPayment: data.receiptQrPayment || null,
        receiptUrduDigits: data.receiptUrduDigits,
        lowStockThreshold: data.lowStockThreshold,
        allowPublicRegistration: data.allowPublicRegistration,
        refundReasonPresets: data.refundReasonPresets || null,
        webhookUrl: data.webhookUrl || null,
        webhookSecret,
        smtpHost: data.smtpHost || null,
        smtpPort: data.smtpPort,
        smtpUser: data.smtpUser || null,
        smtpPassword,
        smtpFromEmail: data.smtpFromEmail || null,
        smtpFromName: data.smtpFromName || null,
        smtpUseTls: data.smtpUseTls,
        lowStockNotifyWebhook: data.lowStockNotifyWebhook,
        lowStockNotifyEmail: data.lowStockNotifyEmail,
        lowStockNotifyAdmins: data.lowStockNotifyAdmins,
        lowStockSchedulerEnabled: data.lowStockSchedulerEnabled,
        lowStockCooldownHours: data.lowStockCooldownHours,
        lowStockMinQuantity: data.lowStockMinQuantity,
        lowStockRunningLowAlerts: data.lowStockRunningLowAlerts,
      },
      create: {
        id: "singleton",
        storeName: data.storeName,
        storeAddress: data.storeAddress || null,
        storePhone: data.storePhone || null,
        storeEmail: data.storeEmail || null,
        taxRate: data.taxRate,
        taxInclusive: data.taxInclusive,
        currency: data.currency,
        receiptHeader: data.receiptHeader || null,
        receiptFooter: data.receiptFooter || null,
        receiptQrPayment: data.receiptQrPayment || null,
        receiptUrduDigits: data.receiptUrduDigits,
        lowStockThreshold: data.lowStockThreshold,
        allowPublicRegistration: data.allowPublicRegistration,
        refundReasonPresets: data.refundReasonPresets || null,
        webhookUrl: data.webhookUrl || null,
        webhookSecret: data.webhookSecret || null,
        smtpHost: data.smtpHost || null,
        smtpPort: data.smtpPort,
        smtpUser: data.smtpUser || null,
        smtpPassword: data.smtpPassword || null,
        smtpFromEmail: data.smtpFromEmail || null,
        smtpFromName: data.smtpFromName || null,
        smtpUseTls: data.smtpUseTls,
        lowStockNotifyWebhook: data.lowStockNotifyWebhook,
        lowStockNotifyEmail: data.lowStockNotifyEmail,
        lowStockNotifyAdmins: data.lowStockNotifyAdmins,
        lowStockSchedulerEnabled: data.lowStockSchedulerEnabled,
        lowStockCooldownHours: data.lowStockCooldownHours,
        lowStockMinQuantity: data.lowStockMinQuantity,
        lowStockRunningLowAlerts: data.lowStockRunningLowAlerts,
      },
    });

    logAudit({
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: "singleton",
      entityName: "Store settings",
      newValues: { changedFields },
    });

    // Mask secrets in the response exactly like GET — the full row (real
    // webhook/smtp credentials) must never leave the server after a save.
    const safeSettings = {
      ...settings,
      webhookSecret: settings.webhookSecret ? SECRET_MASK : null,
      smtpPassword: settings.smtpPassword ? SECRET_MASK : null,
    };

    return NextResponse.json({ settings: safeSettings, message: "Settings saved" });
  } catch (error) {
    console.error("[SETTINGS_PUT]", error);
    return apiError("Internal server error", 500);
  }
}