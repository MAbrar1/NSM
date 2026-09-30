import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { parsePagination } from "@/lib/pagination";
import { parseSortParam } from "@/lib/table-sort";
import { apiError, fieldError } from "@/lib/api-errors";
import { poLineTotals, poTotals } from "@/lib/suppliers/purchase-order-math";

/* ═══════════════════════════════════════════════════════════════
   PURCHASE ORDERS API
   GET  /api/purchase-orders — List with search, status filter
   POST /api/purchase-orders — Create new PO
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("purchase_orders:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const status = searchParams.get("status") || "";
    const supplierId = searchParams.get("supplierId") || "";
    const { page, pageSize: limit, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 20,
      pageSizeParam: "limit",
    });

    const poSort = parseSortParam(
      searchParams.get("sort"),
      ["orderNumber", "supplier", "createdAt", "expectedDate", "total", "status"],
      { field: "createdAt", order: "desc" }
    );

    const where: Prisma.PurchaseOrderWhereInput = {};
    if (status) where.status = status;
    if (supplierId) where.supplierId = supplierId;
    if (search) {
      where.OR = [
        { orderNumber: { contains: search } },
        { supplier: { name: { contains: search } } },
      ];
    }

    const [orders, total] = await Promise.all([
      db.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: {
            include: {
              product: { select: { unit: true, allowFractional: true } },
            },
          },
          _count: { select: { items: true } },
        },
        // Allow-listed sort — a hand-edited query falls back to
        // createdAt.desc instead of reaching Prisma's orderBy and throwing.
        orderBy: { [poSort.field]: poSort.order },
        skip,
        take,
      }),
      db.purchaseOrder.count({ where }),
    ]);

    return NextResponse.json({
      orders,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("GET /api/purchase-orders error:", error);
    return apiError("Failed to fetch purchase orders", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    // Resolve the acting user from the session — never trust a client-supplied ID
    const { user, response } = await requirePermission("purchase_orders:create");
    if (response) return response;

    const body = await request.json();
    const { supplierId, warehouseId, items, notes, expectedDate, shippingCost } = body;

    // Field-keyed so the create dialog can underline the offending select
    // instead of toasting a joint "supplier, warehouse and items required".
    if (!supplierId || !warehouseId || !items?.length) {
      const missing: Record<string, string[]> = {};
      if (!supplierId) missing["supplierId"] = ["Supplier is required"];
      if (!warehouseId) missing["warehouseId"] = ["Warehouse is required"];
      if (!items?.length) missing["items"] = ["Add at least one item"];
      return fieldError(missing);
    }

    // Validate supplier and warehouse exist
    const [supplier, warehouse] = await Promise.all([
      db.supplier.findUnique({ where: { id: supplierId } }),
      db.warehouse.findUnique({ where: { id: warehouseId } }),
    ]);

    if (!supplier) return fieldError({ supplierId: ["Supplier not found"] }, 404);
    if (!warehouse) return fieldError({ warehouseId: ["Warehouse not found"] }, 404);

    // Header and line amounts both come from lib/purchase-order-math, so the
    // tax the PO reports is always the sum of the tax stored on its lines.
    const { subtotal, taxAmount, total } = poTotals(items, shippingCost);

    // The sequence number is derived from a COUNT, so two concurrent
    // creations can pick the same number. Retry on the unique-constraint
    // violation with a fresh count instead of failing the request.
    const createWithNumber = (orderNumber: string) =>
      db.purchaseOrder.create({
        data: {
          orderNumber,
          supplierId,
          warehouseId,
          subtotal,
          taxAmount,
          shippingCost: shippingCost || 0,
          total,
          notes: notes || null,
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          createdById: user.id,
          status: "draft",
          items: {
            create: items.map((item: {
              productId: string;
              productName: string;
              sku: string;
              quantity: number;
              unitCost: number;
              taxRate?: number;
            }) => ({
              productId: item.productId,
              productName: item.productName,
              sku: item.sku,
              quantity: item.quantity,
              unitCost: item.unitCost,
              taxRate: item.taxRate || 0,
              total: poLineTotals(item).lineTotalWithTax,
            })),
          },
        },
        include: {
          supplier: { select: { name: true } },
          warehouse: { select: { name: true } },
          items: true,
        },
      });

    let po: Awaited<ReturnType<typeof createWithNumber>> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = await db.purchaseOrder.count();
      const orderNumber = `PO-${String(count + 1).padStart(6, "0")}`;
      try {
        po = await createWithNumber(orderNumber);
        break;
      } catch (e) {
        const isUniqueViolation =
          typeof e === "object" &&
          e !== null &&
          "code" in e &&
          (e as { code?: string }).code === "P2002";
        if (!isUniqueViolation || attempt === 2) throw e;
        // Collision — retry with a fresh count
      }
    }
    if (!po) {
      throw new Error("Failed to allocate a purchase order number");
    }

    return NextResponse.json({ order: po }, { status: 201 });
  } catch (error) {
    console.error("POST /api/purchase-orders error:", error);
    return apiError("Failed to create purchase order", 500);
  }
}
