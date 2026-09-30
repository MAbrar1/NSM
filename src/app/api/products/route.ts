import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { productSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { logAudit } from "@/lib/audit-log";
import { parsePagination } from "@/lib/api/pagination";
import { sumBaseStock, stockStatus } from "@/lib/inventory/stock-status";
import { majorToCents } from "@/lib/money/money";
import { ensureStockRow } from "@/lib/inventory/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   PRODUCTS API
   GET  /api/products      — List products with search, filters, pagination
   POST /api/products      — Create a new product
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    // Require authentication for product listing
    const { response } = await requirePermission("products:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);

    const { page, pageSize, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 20,
    });
    const search = searchParams.get("search") ?? "";
    const categoryId = searchParams.get("categoryId") ?? undefined;
    const brandId = searchParams.get("brandId") ?? undefined;
    const status = searchParams.get("status") ?? undefined;
    const sortBy = searchParams.get("sortBy") ?? "createdAt";
    const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";

    // Allowlist of sortable fields — an arbitrary client string used to be
    // interpolated straight into the Prisma orderBy and 500'd the request.
    const SORTABLE_FIELDS = new Set(["name", "sku", "unitPrice", "costPrice", "createdAt", "updatedAt", "status"]);
    const sortField = SORTABLE_FIELDS.has(sortBy) ? sortBy : "createdAt";

    // Build where clause
    const where: Record<string, unknown> = {
      deletedAt: null,
      status: "active", // Default to active products (consistent with POS)
    };

    if (search) {
      where["OR"] = [
        { name: { contains: search } },
        { sku: { contains: search } },
        { barcode: { contains: search } },
      ];
    }

    if (categoryId) where["categoryId"] = categoryId;
    if (brandId) where["brandId"] = brandId;
    // "all" shows every non-deleted product; any other explicit status
    // overrides the active default. (Previously an unrecognised filter
    // value like "" fell through as active-only, so the UI's "All Status"
    // option silently showed just active rows.)
    if (status === "all") {
      delete where["status"];
    } else if (status && status !== "active") {
      where["status"] = status;
    }

    const [items, total] = await Promise.all([
      db.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, slug: true } },
          brand: { select: { id: true, name: true, slug: true } },
          stockLevels: {
            select: { quantity: true, reservedQuantity: true, variantId: true, warehouse: { select: { name: true, isDefault: true } } },
          },
        },
        orderBy: { [sortField]: sortOrder },
        skip,
        take,
      }),
      db.product.count({ where }),
    ]);

    // Add computed stock fields. Variant rows are excluded so the table's
    // stock column matches what POS shows for the base product (variant
    // "Family Pack" units are separate, independently-tracked stock).
    // Totals + status come from the SHARED formulas (lib/stock-status),
    // the exact same numbers /api/pos/search and /api/products/lookup
    // return for the same product.
    const itemsWithStock = items.map((item) => {
      const { totalStock, totalReserved, totalAvailable, sellableAvailable } = sumBaseStock(
        item.stockLevels.map((sl) => ({
          quantity: sl.quantity,
          reservedQuantity: sl.reservedQuantity,
          variantId: sl.variantId,
        })),
        item.allowFractional
      );
      return {
        ...item,
        totalStock,
        totalReserved,
        totalAvailable,
        available: sellableAvailable,
        stockStatus: stockStatus(sellableAvailable, item.minStockLevel),
      };
    });

    return NextResponse.json({
      items: itemsWithStock,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      hasNext: page * pageSize < total,
      hasPrevious: page > 1,
    });
  } catch (error) {
    console.error("[PRODUCTS_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await requirePermission("products:create");
    if (authResult.response) return authResult.response;

    const body = await request.json();
    const result = productSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = result.data;

    // Check for duplicate SKU
    const existingSku = await db.product.findUnique({ where: { sku: data.sku } });
    if (existingSku) {
      return fieldError({ sku: ["A product with this SKU already exists"] }, 409);
    }

    // Barcodes are globally unique across products and extra-barcode
    // rows — a duplicate would make scan resolution ambiguous.
    if (data.barcode) {
      const dupeProduct = await db.product.findFirst({ where: { barcode: data.barcode, deletedAt: null } });
      const dupeExtra = await db.productBarcode.findUnique({ where: { barcode: data.barcode } });
      if (dupeProduct || dupeExtra) {
        return fieldError({ barcode: ["This barcode is already assigned to another product"] }, 409);
      }
    }

    // Generate slug from name (append SKU suffix to avoid collisions)
    let slug = data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const existingSlug = await db.product.findUnique({ where: { slug } });
    if (existingSlug) {
      slug = `${slug}-${data.sku.toLowerCase()}`;
    }

    // Create product with optional fields
    const product = await db.product.create({
      data: {
        name: data.name,
        slug,
        sku: data.sku,
        barcode: data.barcode || undefined,
        description: data.description || undefined,
        categoryId: data.categoryId,
        brandId: data.brandId || undefined,
        unitPrice: majorToCents(data.unitPrice),
        costPrice: majorToCents(data.costPrice),
        compareAtPrice: data.compareAtPrice != null && data.compareAtPrice > 0 ? majorToCents(data.compareAtPrice) : undefined,
        taxRate: data.taxRate,
        status: data.status,
        tags: data.tags ? JSON.stringify(data.tags) : undefined,
        trackInventory: data.trackInventory,
        allowDiscount: data.allowDiscount,
        minStockLevel: data.minStockLevel,
        maxStockLevel: data.maxStockLevel,
        unit: data.unit,
        allowFractional: data.allowFractional,
        sellByValue: data.sellByValue,
        unitConversions: data.unitConversions && data.unitConversions.length > 0
          ? JSON.stringify(data.unitConversions)
          : undefined,
      },
      include: {
        category: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
      },
    });

    // Create initial stock level for default warehouse
    const defaultWarehouse = await db.warehouse.findFirst({
      where: { isDefault: true },
    });

    if (defaultWarehouse && data.trackInventory) {
      // The same initial empty row the CSV importer lays down — one rule
      // for "a new tracked product starts with a stock row in the default
      // warehouse" (lib/inventory-service).
      await ensureStockRow(db, {
        productId: product.id,
        warehouseId: defaultWarehouse.id,
      });
    }

    // Log product creation
    logAudit({
      userId: authResult.user.id,
      action: "create",
      entity: "product",
      entityId: product.id,
      entityName: product.name,
      newValues: { name: product.name, sku: product.sku, unitPrice: data.unitPrice, costPrice: data.costPrice, status: data.status },
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (error) {
    console.error("[PRODUCTS_POST]", error);
    return apiError("Internal server error", 500);
  }
}
