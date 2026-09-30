import crypto from "crypto";
import nodemailer from "nodemailer";
import { db } from "@/lib/db";

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATION SERVICE
   Delivers low-stock alerts to the two configured EXTERNAL channels:
   1. Webhook (POST to configurable URL with HMAC-SHA256 signature)
   2. Email (SMTP with TLS)

   The in-app channel is deliberately not delivered from here. An
   in-app alert is DERIVED — the header bell renders the live
   /api/alerts scan, gated by StoreSettings.lowStockNotifyAdmins — so
   there is no delivery record to persist and nothing to fan out.
   ═══════════════════════════════════════════════════════════════ */

export interface LowStockAlertPayload {
  productId: string;
  productName: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  currentStock: number;
  minStockLevel: number;
  severity: "critical" | "warning" | "info";
  kind: "out_of_stock" | "critical" | "below_min" | "running_low";
  timestamp: string;
}

export interface NotificationSettings {
  webhookUrl: string | null;
  webhookSecret: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFromEmail: string | null;
  smtpFromName: string | null;
  smtpUseTls: boolean;
  lowStockNotifyWebhook: boolean;
  lowStockNotifyEmail: boolean;
  lowStockNotifyAdmins: boolean;
  storeName: string;
}

/**
 * Load notification settings from the store settings singleton.
 */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  const settings = await db.storeSettings.findUnique({
    where: { id: "singleton" },
  });

  return {
    webhookUrl: settings?.webhookUrl ?? null,
    webhookSecret: settings?.webhookSecret ?? null,
    smtpHost: settings?.smtpHost ?? null,
    smtpPort: settings?.smtpPort ?? 587,
    smtpUser: settings?.smtpUser ?? null,
    smtpPassword: settings?.smtpPassword ?? null,
    smtpFromEmail: settings?.smtpFromEmail ?? null,
    smtpFromName: settings?.smtpFromName ?? null,
    smtpUseTls: settings?.smtpUseTls ?? true,
    lowStockNotifyWebhook: settings?.lowStockNotifyWebhook ?? false,
    lowStockNotifyEmail: settings?.lowStockNotifyEmail ?? false,
    lowStockNotifyAdmins: settings?.lowStockNotifyAdmins ?? true,
    storeName: settings?.storeName ?? "Store",
  };
}

/**
 * Send a low-stock alert to all configured notification channels.
 * Runs in the background (fire-and-forget) so it doesn't block the caller.
 */
export async function sendLowStockAlert(alert: LowStockAlertPayload): Promise<void> {
  const settings = await getNotificationSettings();

  const promises: Promise<void>[] = [];

  if (settings.lowStockNotifyWebhook && settings.webhookUrl) {
    promises.push(sendWebhook(settings, alert));
  }

  if (settings.lowStockNotifyEmail && settings.smtpHost && settings.smtpFromEmail) {
    promises.push(sendEmail(settings, alert));
  }

  // Fire-and-forget: log errors but don't throw
  if (promises.length > 0) {
    Promise.allSettled(promises).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[NOTIFY] Alert delivery failed:", r.reason);
        }
      }
    });
  }
}

/**
 * POST alert payload to the configured webhook URL.
 * Signs the payload with HMAC-SHA256 if a secret is configured.
 */
async function sendWebhook(
  settings: NotificationSettings,
  alert: LowStockAlertPayload
): Promise<void> {
  if (!settings.webhookUrl) return;

  const payload = JSON.stringify({
    event: "low_stock_alert",
    store: settings.storeName,
    data: alert,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "ElitePOS-Webhook/1.0",
  };

  // HMAC-SHA256 signature for payload verification
  if (settings.webhookSecret) {
    const signature = crypto
      .createHmac("sha256", settings.webhookSecret)
      .update(payload)
      .digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }

  const res = await fetch(settings.webhookUrl, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    console.error(`[NOTIFY] Webhook returned ${res.status}: ${res.statusText}`);
  }
}

/**
 * Send alert via SMTP email using nodemailer (SMTP with TLS).
 * Only ever called from server-side code (this module is never
 * imported into client bundles).
 */
async function sendEmail(
  settings: NotificationSettings,
  alert: LowStockAlertPayload
): Promise<void> {
  try {
    const transporter = nodemailer.createTransport({
      host: settings.smtpHost!,
      port: settings.smtpPort,
      secure: settings.smtpUseTls && settings.smtpPort === 465,
      auth: settings.smtpUser
        ? { user: settings.smtpUser, pass: settings.smtpPassword ?? "" }
        : undefined,
      tls: settings.smtpUseTls && settings.smtpPort !== 465 ? { rejectUnauthorized: false } : undefined,
    });

    const severityEmoji = {
      critical: "🔴",
      warning: "🟡",
      info: "🔵",
    };

    const subject = `${severityEmoji[alert.severity]} Low Stock: ${alert.productName} (${alert.sku})`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: ${alert.severity === "critical" ? "#dc2626" : alert.severity === "warning" ? "#d97706" : "#2563eb"}; margin-bottom: 16px;">
          ${severityEmoji[alert.severity]} Low Stock Alert
        </h2>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr><td style="padding: 8px 0; color: #666;">Product</td><td style="padding: 8px 0; font-weight: 600;">${alert.productName}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">SKU</td><td style="padding: 8px 0; font-family: monospace;">${alert.sku}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">Warehouse</td><td style="padding: 8px 0;">${alert.warehouseName}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">Current Stock</td><td style="padding: 8px 0; font-weight: 700; color: ${alert.currentStock === 0 ? "#dc2626" : "#d97706"};">${alert.currentStock}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">Minimum Level</td><td style="padding: 8px 0;">${alert.minStockLevel}</td></tr>
          <tr><td style="padding: 8px 0; color: #666;">Severity</td><td style="padding: 8px 0; text-transform: capitalize;">${alert.severity}</td></tr>
        </table>
        <hr style="margin: 16px 0; border: none; border-top: 1px solid #eee;" />
        <p style="color: #999; font-size: 12px;">Sent by ${settings.storeName} POS System</p>
      </div>
    `;

    // sendEmail is only invoked when smtpFromEmail is set (see sendLowStockAlert)
    const fromEmail = settings.smtpFromEmail!;
    await transporter.sendMail({
      from: `"${settings.smtpFromName || settings.storeName}" <${fromEmail}>`,
      to: fromEmail, // Admin receives at the configured email
      subject,
      html,
    });
  } catch (err) {
    console.error("[NOTIFY] Email send failed:", err);
  }
}
