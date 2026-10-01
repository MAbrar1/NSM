import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { apiError, fieldError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { parsePagination } from "@/lib/api/pagination";
import { parseSortParam } from "@/lib/table-sort";
import { slugify } from "@/lib/utils";
import { supplierPurchaseStats } from "@/lib/suppliers/supplier-stats";

/* ═══════════════════════════════════════════════════════════════
   SUPPLIERS API
   GET  /api/suppliers       — List with search, pagination
   POST /api/suppliers       — Create new supplier
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("suppliers:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const { page, pageSize: limit, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 20,
      pageSizeParam: "limit",
    });

    const where: Prisma.SupplierWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ];
    }

    // Allow-listed sort — a hand-edited query falls back to name.asc
    // instead of reaching Prisma's orderBy and throwing. The count
    // columns sort on real relation counts via Prisma's _count syntax.
    const sort = parseSortParam(
      searchParams.get("sort"),
      ["name", "email", "phone", "city", "country", "paymentTerms", "rating", "createdAt", "products", "purchaseOrders"],
      { field: "name", order: "asc" }
    );
    const sortField =
      sort.field === "products"
        ? "products"
        : sort.field === "purchaseOrders"
          ? "purchaseOrders"
          : sort.field;

    // Count columns sort on real relation counts (Prisma's _count syntax);
    // everything else is a plain column, with nulls last so "—" rows don't
    // bunch at the top of an ascending sort.
    const orderBy: Prisma.SupplierOrderByWithRelationInput =
      sortField === "products"
        ? { products: { _count: sort.order } }
        : sortField === "purchaseOrders"
          ? { purchaseOrders: { _count: sort.order } }
          : { [sortField]: { sort: sort.order, nulls: "last" } };

    const [suppliers, total] = await Promise.all([
      db.supplier.findMany({
        where,
        include: {
          _count: { select: { products: true, purchaseOrders: true } },
          purchaseOrders: {
            select: { total: true, status: true },
          },
        },
        orderBy,
        skip,
        take,
      }),
      db.supplier.count({ where }),
    ]);

    // Compute stats for each supplier
    const suppliersWithStats = suppliers.map((s) => {
      const { totalSpent, totalOrders } = supplierPurchaseStats(s.purchaseOrders);
      const rating = s.rating;
      return {
        ...s,
        stats: { totalSpent, totalOrders, rating },
        purchaseOrders: undefined,
      };
    });

    return NextResponse.json({
      suppliers: suppliersWithStats,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("GET /api/suppliers error:", error);
    return apiError("Failed to fetch suppliers", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { response } = await requirePermission("suppliers:create");
    if (response) return response;

    const body = await request.json();
    const { name, email, phone, address, city, country, taxId, paymentTerms, rating, notes } = body;

    if (!name) {
      return fieldError({ name: ["Name is required"] }, 400);
    }

    // Check for duplicate slug
    const slug = slugify(name);

    const existing = await db.supplier.findUnique({ where: { slug } });
    if (existing) {
      return fieldError({ name: ["A supplier with a similar name already exists"] }, 409);
    }

    // Check duplicate email
    if (email) {
      const dupEmail = await db.supplier.findFirst({ where: { email, deletedAt: null } });
      if (dupEmail) {
        return fieldError({ email: ["Email already in use"] }, 409);
      }
    }

    const supplier = await db.supplier.create({
      data: {
        name,
        slug,
        email: email || null,
        phone: phone || null,
        address: address || null,
        city: city || null,
        country: country || null,
        taxId: taxId || null,
        paymentTerms: paymentTerms || 30,
        rating: rating || 0,
        notes: notes || null,
      },
    });

    return NextResponse.json({ supplier }, { status: 201 });
  } catch (error) {
    console.error("POST /api/suppliers error:", error);
    return apiError("Failed to create supplier", 500);
  }
}
