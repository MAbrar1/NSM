import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit-log";
import { retryOnUniqueConflict } from "@/lib/retry";
import { triggerLowStockScan } from "@/lib/low-stock-scheduler";
import { loyaltyPointsForSpend } from "@/lib/earn-rate";
import {
  resolvePayment,
  allocateSettlement,
  orderStatusAfterSettlement,
} from "@/lib/money/payment-math";
import {
  reconcileCheckoutLine,
  reconcileCartTotals,
  resolveLoyaltyRedemption,
} from "@/lib/checkout-math";
import { applySaleToCustomer } from "@/lib/customer-balance";
import { deductForSale } from "@/lib/inventory-service";
import { revenueStatuses } from "@/lib/report-math";
import {
  allocateReceiptNo,
  resolveTerminalId,
} from "@/lib/receipt-number";
import {
  buildReceiptSnapshot,
  computeReceiptContentHash,
  RECEIPT_TEMPLATE_VERSION,
} from "@/lib/receipt-snapshot";

/* ═══════════════════════════════════════════════════════════════
   CHECKOUT SERVICE
   The complete POS checkout pipeline, extracted from the API route
   so the real transaction logic can be integration-tested against a
   real database (see tests/checkout-integration.test.ts).

   SERVER-AUTHORITATIVE MONEY:
   Prices, tax rates and costs are re-read from the database — the
   client's unitPrice/costPrice/taxAmount/total are only *compared*
   against the recomputed values so a stale or tampered cart is rejected
   instead of recorded. All stored amounts are the server-computed ones.

   STOCK SAFETY:
   - Tracked products must have a stock row; selling proceeds only when
     an atomic conditional UPDATE (`WHERE quantity >= requested`)
     succeeds, so concurrent checkouts can never oversell the last unit.
   - Any reserved portion of the sold quantity is released (reserved
     can never exceed the new on-hand quantity).
   ═══════════════════════════════════════════════════════════════ */

/** Checkout failed validation → map `code` to the HTTP response. */
export class CheckoutError extends Error {
  constructor(
    public code: "insufficient_stock" | "item_validation" | "bad_request",
    message: string,
    public extra?: {
      productId?: string;
      productName?: string;
      available?: number;
      requested?: number;
    }
  ) {
    super(message);
  }
}

export const checkoutItemSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().optional(),
  productName: z.string(),
  sku: z.string(),
  quantity: z.number().positive(), // Fractional allowed (e.g. 0.385 kg sugar)
  unit: z.string().max(20).optional(),
  unitPrice: z.number().int().min(0),
  costPrice: z.number().int().min(0),
  discountType: z.enum(["percentage", "fixed"]).optional(),
  discountValue: z.number().min(0).optional(),
  discountAmount: z.number().int().min(0).default(0),
  taxRate: z.number().min(0).max(100).default(0),
  taxAmount: z.number().int().min(0).default(0),
  total: z.number().int().min(0),
});

export const checkoutSchema = z.object({
  warehouseId: z.string().min(1),
  customerId: z.string().optional(),
  items: z.array(checkoutItemSchema).min(1, "At least one item required"),
  subtotal: z.number().int().min(0),
  taxAmount: z.number().int().min(0),
  discountAmount: z.number().int().min(0),
  total: z.number().int().min(0),
  // Loyalty points to redeem — 1 point = 1 cent off the total.
  loyaltyPointsRedeemed: z.number().int().min(0).default(0),
  paymentMethod: z.enum([
    "cash", "credit_card", "debit_card",
    "digital_wallet", "bank_transfer", "store_credit",
  ]),
  amountPaid: z.number().int().min(0),
  changeDue: z.number().int().min(0),
  // Cents to collect toward the customer's PREVIOUS balance (khata) in the
  // same transaction. Server-clamped: never more than the customer owes
  // and never more than the cash tendered beyond the current bill.
  settleOutstanding: z.number().int().min(0).optional(),
  // Which register issued this sale (drives the per-terminal receipt series).
  terminalId: z.string().max(40).optional(),
  notes: z.string().max(500).optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface CheckoutActor {
  /** Resolved server-side from the session — never trust client IDs. */
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Resolve the warehouse server-side: the legacy client sent a literal
 * "default" placeholder when no warehouse was selected — never let that
 * reach the FK. Falls back to the store's default warehouse. Returns
 * null when no usable warehouse exists (caller decides the response).
 */
export async function resolveCheckoutWarehouse(
  warehouseId?: string
): Promise<string | null> {
  let id = warehouseId ?? "";
  if (!id || id === "default") {
    const defaultWh = await db.warehouse.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true },
    });
    id = defaultWh?.id ?? "";
  }
  if (!id) return null;
  const warehouse = await db.warehouse.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  return warehouse && warehouse.isActive ? id : null;
}

/**
 * Process a complete POS transaction: validates the cart against the
 * server catalog, creates the order/items/payments, deducts stock
 * atomically, releases reservations, updates customer loyalty stats,
 * and logs the audit event.
 *
 * Throws CheckoutError on any business-rule violation. Returns the
 * complete order (with items/payments/user/customer) for the receipt.
 */
export async function processCheckout(
  data: CheckoutInput,
  actor: CheckoutActor
): Promise<NonNullable<Awaited<ReturnType<typeof loadCompleteOrder>>>> {
  // Resolve the warehouse server-side.
  const warehouseId = await resolveCheckoutWarehouse(data.warehouseId);
  if (!warehouseId) {
    throw new CheckoutError(
      "bad_request",
      "No warehouse selected. Choose a warehouse before checking out."
    );
  }
  const input = { ...data, warehouseId };

  // The cashier's name is frozen into the receipt snapshot at issue
  // time (a later rename must not rewrite old receipts).
  const cashierUser = await db.user.findUnique({
    where: { id: actor.userId },
    select: { name: true },
  });
  const cashierName = cashierUser?.name ?? null;

  // Generate the order number inside a retry loop: the count-based
  // sequence can collide when two registers check out concurrently.
  // On a unique-constraint violation we simply re-count and retry.
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  const createOrderWithNumber = async (orderNumber: string) =>
    db.$transaction(async (tx) => {
      // ── 0. Server-authoritative catalog lookup ─────────────────────
      // Re-read every product (and variant) so prices, costs, tax rates
      // and stock are never taken from the client payload.
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const products = await tx.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true, name: true, sku: true, unitPrice: true, costPrice: true,
          taxRate: true, status: true, deletedAt: true, trackInventory: true,
        },
      });
      const productMap = new Map(products.map((p) => [p.id, p]));

      const variantIds = input.items
        .map((i) => i.variantId)
        .filter((v): v is string => Boolean(v));
      // Variants carry their own price but inherit the parent's tax rate.
      const variants = variantIds.length > 0
        ? await tx.productVariant.findMany({
            where: { id: { in: variantIds } },
            select: { id: true, productId: true, unitPrice: true, costPrice: true, isActive: true },
          })
        : [];
      const variantMap = new Map(variants.map((v) => [v.id, v]));

      // Recompute every line from server prices; compare with the client's
      // numbers so stale carts (price changed mid-sale) fail loudly.
      const resolvedItems: Array<{
        productId: string;
        variantId?: string;
        productName: string;
        sku: string;
        quantity: number;
        unit: string;
        unitPrice: number;
        costPrice: number;
        taxRate: number;
        discountAmount: number;
        taxAmount: number;
        total: number;
        trackInventory: boolean;
      }> = [];

      let orderSubtotal = 0;
      let orderDiscount = 0;
      let orderTax = 0;
      let orderTotal = 0;

      for (const item of input.items) {
        const product = productMap.get(item.productId);
        if (!product || product.deletedAt || product.status !== "active") {
          throw new CheckoutError(
            "item_validation",
            `${item.productName || item.sku || "Item"} is no longer available for sale`
          );
        }

        let serverUnitPrice = product.unitPrice;
        let serverCostPrice = product.costPrice;
        let serverTaxRate = product.taxRate;
        if (item.variantId) {
          const variant = variantMap.get(item.variantId);
          if (!variant || variant.productId !== product.id || !variant.isActive) {
            throw new CheckoutError(
              "item_validation",
              `${product.name} variant is no longer available for sale`
            );
          }
          serverUnitPrice = variant.unitPrice;
          serverCostPrice = variant.costPrice;
          // Variants have no tax rate of their own — use the parent's.
          serverTaxRate = product.taxRate;
        }

        // Recompute this line from server prices and reject tampered/
        // stale figures — rules live in lib/checkout-math (unit-tested).
        const reconciliation = reconcileCheckoutLine(
          {
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            quantity: item.quantity,
            discountType: item.discountType,
            discountValue: item.discountValue,
            discountAmount: item.discountAmount,
            taxAmount: item.taxAmount,
            total: item.total,
          },
          {
            unitPrice: serverUnitPrice,
            costPrice: serverCostPrice,
            taxRate: serverTaxRate,
          },
          product.name
        );
        if (!reconciliation.ok) {
          throw new CheckoutError("item_validation", reconciliation.error);
        }
        const subtotal = reconciliation.subtotal;
        const discount = reconciliation.discount;
        const tax = reconciliation.taxAmount;
        const total = reconciliation.total;

        resolvedItems.push({
          productId: product.id,
          variantId: item.variantId,
          productName: product.name,
          sku: product.sku,
          quantity: item.quantity,
          unit: item.unit || "pcs",
          unitPrice: serverUnitPrice,
          costPrice: serverCostPrice,
          taxRate: serverTaxRate,
          discountAmount: Math.round(discount),
          taxAmount: tax,
          total,
          trackInventory: product.trackInventory,
        });

        orderSubtotal += subtotal;
        orderDiscount += discount;
        orderTax += tax;
        orderTotal += total;
      }

      // Round the order-level money to integer cents like every line.
      orderSubtotal = Math.round(orderSubtotal);
      orderDiscount = Math.round(orderDiscount);
      orderTax = Math.round(orderTax);
      orderTotal = Math.round(orderTotal);

      // The client's cart-level figures must agree with the recomputed ones.
      // `total` here is the PRE-redemption total — loyalty is applied on
      // top of it server-side, never trusted from the payload.
      const cartCheck = reconcileCartTotals(
        {
          subtotal: data.subtotal,
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          total: data.total,
        },
        {
          subtotal: orderSubtotal,
          taxAmount: orderTax,
          discountAmount: orderDiscount,
          total: orderTotal,
        }
      );
      if (!cartCheck.ok) {
        throw new CheckoutError("item_validation", cartCheck.error);
      }

      // ── Loyalty redemption ────────────────────────────────────────
      // 1 point = 1 cent. The server reads the customer's real balance
      // and caps the redemption, so a forged payload can never over-spend
      // someone else's points. Rules live in lib/checkout-math.
      // A provided customerId is ALWAYS validated first (even with no
      // redemption) so a bogus id fails with a friendly message instead
      // of an FK crash halfway through the transaction.
      let customerRow: {
        id: string;
        loyaltyPoints: number;
        outstandingBalance: number;
      } | null = null;
      if (input.customerId) {
        customerRow = await tx.customer.findFirst({
          where: { id: input.customerId, isActive: true },
          select: { id: true, loyaltyPoints: true, outstandingBalance: true },
        });
        if (!customerRow) {
          throw new CheckoutError(
            "item_validation",
            "The selected customer does not exist or is inactive."
          );
        }
      }

      let loyaltyRedeemedCents = 0;
      let loyaltyPointsRedeemed = 0;
      if (input.loyaltyPointsRedeemed > 0) {
        const loyalty = resolveLoyaltyRedemption(
          input.loyaltyPointsRedeemed,
          customerRow?.loyaltyPoints ?? 0,
          orderTotal,
          Boolean(customerRow)
        );
        if (!loyalty.ok) {
          throw new CheckoutError("item_validation", loyalty.error);
        }
        loyaltyRedeemedCents = loyalty.cents;
        loyaltyPointsRedeemed = loyalty.points;
      }

      const finalTotal = Math.max(0, orderTotal - loyaltyRedeemedCents);

      // ── Partial payment (khata/credit) resolution ─────────────────
      // A short payment is ONLY allowed when a customer is attached:
      // the shortfall becomes that customer's credit due. Without a
      // customer the register must collect the full bill.
      const payment = resolvePayment(finalTotal, input.amountPaid, Boolean(customerRow));
      if (!customerRow && input.amountPaid < finalTotal) {
        throw new CheckoutError(
          "item_validation",
          `Amount paid (${input.amountPaid} cents) is less than the order total (${finalTotal} cents)`
        );
      }
      const amountCollected = payment.collected;
      const dueAmount = payment.dueAmount;
      const changeDue = payment.changeDue;

      // ── Collect PREVIOUS khata dues in the same transaction ──────
      // The register can take money toward the customer's OLD balance
      // while ringing up the new sale. Server-clamped: never more than
      // the customer actually owes. The extra cash is allocated FIFO
      // across their open credit orders (shared rule with the Customers
      // page settlement endpoint).
      let settleApplied = 0;
      const settleOrders: string[] = [];
      if (input.settleOutstanding && input.settleOutstanding > 0) {
        if (!customerRow) {
          throw new CheckoutError(
            "item_validation",
            "Cannot settle previous dues without a customer."
          );
        }
        const owed = Math.max(0, customerRow.outstandingBalance);
        const requested = Math.min(input.settleOutstanding, owed);
        if (requested > 0) {
          const openOrders = await tx.order.findMany({
            where: {
              customerId: customerRow.id,
              dueAmount: { gt: 0 },
              status: { in: revenueStatuses() },
            },
            orderBy: { createdAt: "asc" },
            select: { id: true, dueAmount: true, paidAmount: true, total: true, createdAt: true },
          });
          const { allocations } = allocateSettlement(openOrders, requested);
          for (const alloc of allocations) {
            const order = openOrders.find((o) => o.id === alloc.orderId);
            if (!order) continue;
            const newPaid = order.paidAmount + alloc.amount;
            const newDue = Math.max(0, order.dueAmount - alloc.amount);
            await tx.order.update({
              where: { id: alloc.orderId },
              data: {
                paidAmount: newPaid,
                dueAmount: newDue,
                paymentStatus: orderStatusAfterSettlement(order.total, order.paidAmount, alloc.amount),
              },
            });
            await tx.payment.create({
              data: {
                orderId: alloc.orderId,
                method: input.paymentMethod,
                amount: alloc.amount,
                status: "completed",
                reference: `Collected at register with ${orderNumber}`,
              },
            });
            settleOrders.push(alloc.orderId);
            settleApplied += alloc.amount;
          }
        }
      }

      // ── 1. Create the order ────────────────────────────────────────
      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          customerId: input.customerId || undefined,
          userId: actor.userId,
          warehouseId: input.warehouseId,
          status: "completed",
          type: "sale",
          subtotal: orderSubtotal,
          taxAmount: orderTax,
          discountAmount: orderDiscount,
          total: orderTotal,
          paidAmount: amountCollected,
          changeAmount: changeDue,
          dueAmount,
          paymentStatus: payment.paymentStatus,
          loyaltyRedeemed: loyaltyRedeemedCents,
          loyaltyPointsRedeemed,
          notes: input.notes,
          receiptPrinted: false,
        },
      });

      // ── 2. Create order items and deduct stock ─────────────────────
      for (const item of resolvedItems) {
        await tx.orderItem.create({
          data: {
            orderId: newOrder.id,
            productId: item.productId,
            variantId: item.variantId || undefined,
            productName: item.productName,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            discountAmount: item.discountAmount,
            taxRate: item.taxRate,
            taxAmount: item.taxAmount,
            total: item.total,
          },
        });

        // Stock is only tracked for inventory-tracked products. Non-tracked
        // products may legitimately have no stock row — skip them.
        //
        // The row lookup, the atomic guarded decrement (WHERE quantity >=
        // requested, so two concurrent checkouts cannot sell the same unit)
        // and the release of the just-sold reserved portion all live in
        // lib/inventory-service, so selling cannot drift from the other
        // stock writers.
        if (item.trackInventory) {
          const sale = await deductForSale(
            tx,
            {
              productId: item.productId,
              warehouseId: input.warehouseId,
              variantId: item.variantId ?? null,
            },
            item.quantity
          );

          if (!sale.ok) {
            // No stock row reports available 0; a lost race reports the
            // quantity the row actually holds.
            throw new CheckoutError("insufficient_stock",
              `Insufficient stock for ${item.productName}. Available: ${sale.available}, Requested: ${item.quantity}`,
              { productId: item.productId, productName: item.productName, available: sale.available, requested: item.quantity }
            );
          }
        }

        // Log inventory movement
        await tx.inventoryMovement.create({
          data: {
            productId: item.productId,
            warehouseId: input.warehouseId,
            type: "sale",
            quantity: -item.quantity,
            referenceId: newOrder.id,
            referenceType: "order",
            notes: `POS Sale - ${orderNumber}`,
            performedById: actor.userId,
          },
        });
      }

      // ── 3. Create payment record (what was actually collected) ─────
      // On a credit sale only the collected portion is a completed
      // payment; the shortfall lives on the order's dueAmount instead.
      if (amountCollected > 0) {
        await tx.payment.create({
          data: {
            orderId: newOrder.id,
            method: input.paymentMethod,
            amount: amountCollected,
            status: "completed",
          },
        });
      }

      // ── 4. Update customer stats (incl. loyalty earn + burn) ───────
      // Earn 1 point per whole dollar on the PRE-redemption total, then
      // burn the redeemed points; the running credit moves by the new
      // shortfall less any old dues collected here. The rule (and its
      // concurrent-redemption guard) lives in lib/customer-balance.
      if (input.customerId) {
        await applySaleToCustomer(tx, {
          customerId: input.customerId,
          orderTotal,
          dueAmount,
          settleApplied,
          loyaltyEarned: loyaltyPointsForSpend(orderTotal),
          loyaltyRedeemed: loyaltyPointsRedeemed,
        });
      }

      // Carry settlement info out to the audit log.
      (newOrder as { __settle?: { applied: number; orders: string[] } }).__settle = {
        applied: settleApplied,
        orders: settleOrders,
      };

      // ── 5. Issue the receipt inside the SAME transaction ─────────
      // Order + items + stock + payments + receipt number + frozen
      // snapshot + content hash commit atomically: any failure rolls
      // back everything, and the gap-free series never burns a number.
      const terminalId = resolveTerminalId(input.terminalId);
      const receiptNo = await allocateReceiptNo(tx, terminalId);

      const settingsRow = await tx.storeSettings.findUnique({ where: { id: "singleton" } });
      const snapshot = buildReceiptSnapshot({
        receiptNo,
        terminalId,
        issuedAt: now,
        language: "en",
        order: {
          subtotal: orderSubtotal,
          taxAmount: orderTax,
          discountAmount: orderDiscount,
          total: orderTotal,
          paidAmount: amountCollected,
          changeAmount: changeDue,
          dueAmount,
          paymentStatus: payment.paymentStatus,
          loyaltyRedeemed: loyaltyRedeemedCents,
          loyaltyPointsRedeemed,
          items: resolvedItems.map((it) => ({
            productName: it.productName,
            sku: it.sku,
            quantity: it.quantity,
            unit: it.unit,
            unitPrice: it.unitPrice,
            discountAmount: it.discountAmount,
            taxRate: it.taxRate,
            taxAmount: it.taxAmount,
            total: it.total,
          })),
        },
        cashierName: cashierName ?? "",
        customerName: customerRow?.id
          ? (await tx.customer.findUnique({ where: { id: customerRow.id }, select: { name: true } }))?.name ?? null
          : null,
        customerLoyaltyBalance: await (async () => {
          if (!customerRow) return 0;
          const c = await tx.customer.findUnique({ where: { id: customerRow.id }, select: { loyaltyPoints: true } });
          return c?.loyaltyPoints ?? 0;
        })(),
        settings: {
          storeName: settingsRow?.storeName ?? "Store",
          storeAddress: settingsRow?.storeAddress ?? null,
          storePhone: settingsRow?.storePhone ?? null,
          receiptHeader: settingsRow?.receiptHeader ?? null,
          receiptFooter: settingsRow?.receiptFooter ?? null,
          receiptQrPayment: settingsRow?.receiptQrPayment ?? null,
          receiptUrduDigits: settingsRow?.receiptUrduDigits ?? false,
        },
      });

      const receipt = await tx.receipt.create({
        data: {
          receiptNo,
          terminalId,
          orderId: newOrder.id,
          issuedAt: now,
          templateVersion: RECEIPT_TEMPLATE_VERSION,
          language: "en",
          contentHash: computeReceiptContentHash(snapshot, RECEIPT_TEMPLATE_VERSION),
          snapshotJson: JSON.stringify(snapshot),
          status: "ISSUED",
        },
      });

      return newOrder;
    });

  // Allocate a sequential order number safely: two concurrent checkouts can
  // compute the same count-based number, so on a unique-constraint collision
  // we re-count and retry (bounded by retryOnUniqueConflict).
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const order = await retryOnUniqueConflict(async () => {
    const countToday = await db.order.count({ where: { createdAt: { gte: dayStart } } });
    const orderNumber = `POS-${dateStr}-${String(countToday + 1).padStart(4, "0")}`;
    return createOrderWithNumber(orderNumber);
  });

  // Settlement totals ride on the returned order object — read them for
  // the audit log (the transaction itself returns only the order).
  const { applied: auditSettleApplied, orders: auditSettleOrders } =
    (order as { __settle?: { applied: number; orders: string[] } }).__settle ?? {
      applied: 0,
      orders: [],
    };

  const completeOrder = await loadCompleteOrder(order.id);
  if (!completeOrder) {
    // The order was created milliseconds ago — this is a database fault.
    throw new CheckoutError("item_validation", "Order disappeared after creation — verify the database.");
  }

  // Log the checkout event
  logAudit({
    userId: actor.userId,
    action: "checkout",
    entity: "order",
    entityId: order.id,
    entityName: order.orderNumber,
    newValues: {
      total: order.total,
      itemCount: input.items.length,
      paymentMethod: input.paymentMethod,
      customerId: input.customerId,
      loyaltyRedeemed: order.loyaltyRedeemed,
      ...(auditSettleApplied > 0
        ? { settledPreviousDues: auditSettleApplied, settledOrders: auditSettleOrders }
        : {}),
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  // A sale just drained stock — fire a low-stock check immediately so a
  // register that sells the last unit alerts in seconds, not at the next
  // interval. Fire-and-forget + cooldown-throttled; never blocks checkout.
  triggerLowStockScan("checkout");

  return completeOrder;
}

async function loadCompleteOrder(orderId: string) {
  return db.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      payments: true,
      user: { select: { name: true } },
      // outstandingBalance here is the customer's balance AFTER this sale
      // committed — the receipt uses it for the "outstanding balance" line.
      customer: { select: { name: true, email: true, outstandingBalance: true } },
    },
  });
}
