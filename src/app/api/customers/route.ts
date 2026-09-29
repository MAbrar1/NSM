import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError, validationError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { customerSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api-auth";
import { parsePagination } from "@/lib/pagination";

/* ═══════════════════════════════════════════════════════════════
   CUSTOMERS API
   GET  /api/customers — List customers with search & pagination
   POST /api/customers — Create new customer
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("customers:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? "";
    const { page, pageSize, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 20,
    });
    const sortBy = searchParams.get("sortBy") ?? "createdAt";
    const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";

    const where: Record<string, unknown> = { isActive: true };
    if (search) {
      where["OR"] = [
        { name: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ];
    }

    const [items, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take,
        include: {
          _count: { select: { orders: true, cart: true } },
        },
      }),
      db.customer.count({ where }),
    ]);

    return NextResponse.json({
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      hasNext: page * pageSize < total,
    });
  } catch (error) {
    console.error("[CUSTOMERS_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { response } = await requirePermission("customers:create");
    if (response) return response;

    const body = await request.json();
    const result = customerSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = result.data;

    // Check for duplicate email
    if (data.email) {
      const existing = await db.customer.findFirst({
        where: { email: data.email, isActive: true },
      });
      if (existing) {
        return fieldError({ email: ["A customer with this email already exists"] }, 409);
      }
    }

    const customer = await db.customer.create({
      data: {
        name: data.name,
        email: data.email || undefined,
        phone: data.phone || undefined,
        address: data.address || undefined,
        taxId: data.taxId || undefined,
        notes: data.notes || undefined,
      },
    });

    return NextResponse.json({ customer }, { status: 201 });
  } catch (error) {
    console.error("[CUSTOMERS_POST]", error);
    return apiError("Internal server error", 500);
  }
}
