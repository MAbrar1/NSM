import { NextResponse } from "next/server";
import { apiError, fieldError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { customerSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   SINGLE CUSTOMER API
   GET    /api/customers/:id — Get customer with purchase history
   PUT    /api/customers/:id — Update customer
   DELETE /api/customers/:id — Soft-delete customer
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler<{ id: string }>("CUSTOMER_GET", async (_request, ctx) => {
    const { response } = await requirePermission("customers:view");
    if (response) return response;

    const { id } = await ctx.params;
    const customer = await db.customer.findUnique({
      where: { id },
      include: {
        orders: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: {
            items: { select: { productName: true, quantity: true, total: true } },
          },
        },
      },
    });

    if (!customer) {
      return apiError("Customer not found", 404);
    }

    // Calculate stats
    const totalSpent = customer.orders
      .filter((o) => o.status === "completed")
      .reduce((sum, o) => sum + o.total, 0);

    // Credit (khata) exposure: count of open credit orders + total dues.
    const openCreditOrders = await db.order.findMany({
      where: { customerId: id, dueAmount: { gt: 0 } },
      orderBy: { createdAt: "asc" },
      select: { id: true, orderNumber: true, total: true, paidAmount: true, dueAmount: true, paymentStatus: true, createdAt: true },
    });

    return NextResponse.json({
      customer: {
        ...customer,
        calculatedTotalSpent: totalSpent,
        recentOrderCount: customer.orders.length,
        openCreditOrders,
        creditOrderCount: openCreditOrders.length,
      },
    });
  });

export const PUT = withApiHandler<{ id: string }>("CUSTOMER_PUT", async (request, ctx) => {
    const { user, response } = await requirePermission("customers:edit");
    if (response) return response;

    const { id } = await ctx.params;
    const body = await request.json();
    const result = customerSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const existing = await db.customer.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Customer not found", 404);
    }

    const data = result.data;

    // Check for duplicate email (excluding this customer)
    if (data.email) {
      const dup = await db.customer.findFirst({
        where: { email: data.email, isActive: true, id: { not: id } },
      });
      if (dup) {
        return fieldError({ email: ["A customer with this email already exists"] }, 409);
      }
    }

    const customer = await db.customer.update({
      where: { id },
      data: {
        name: data.name,
        // The form always sends every field: an empty string means the user
        // CLEARED it and must erase the stored value — `|| undefined` used
        // to keep the old value forever (email/phone/address were
        // un-clearable).
        email: data.email === undefined ? undefined : data.email || null,
        phone: data.phone === undefined ? undefined : data.phone || null,
        address: data.address === undefined ? undefined : data.address || null,
        taxId: data.taxId === undefined ? undefined : data.taxId || null,
        notes: data.notes === undefined ? undefined : data.notes || null,
      },
    });

    logAudit({
      userId: user.id,
      action: "update",
      entity: "customer",
      entityId: customer.id,
      entityName: customer.name,
      newValues: { name: customer.name, email: customer.email, phone: customer.phone },
    });

    return NextResponse.json({ customer });
  });

export const DELETE = withApiHandler<{ id: string }>("CUSTOMER_DELETE", async (_request, ctx) => {
    const { response } = await requirePermission("customers:delete");
    if (response) return response;

    const { id } = await ctx.params;
    const existing = await db.customer.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Customer not found", 404);
    }

    await db.customer.update({
      where: { id },
      data: { isActive: false, updatedAt: new Date() },
    });

    return NextResponse.json({ message: "Customer removed" });
  });
