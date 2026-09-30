import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { productSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { logAudit } from "@/lib/audit-log";
import { sumStockRows } from "@/lib/stock-status";
import { majorToCents } from "@/lib/money/money";

/* ═══════════════════════════════════════════════════════════════
   SINGLE PRODUCT API
   GET    /api/products/:id  — Get product by ID
   PUT    /api/products/:id  — Update product
   DELETE /api/products/:id  — Soft-delete product
   ═══════════════════════════════════════════════════════════════ */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("products:view");
    if (response) return response;

    const { id } = await params;
    const product = await db.product.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        brand: { select: { id: true, name: true, slug: true } },
        stockLevels: {
          include: { warehouse: { select: { id: true, name: true, code: true } } },
        },
        variants: true,
      },
    });

    if (!product) {
      return apiError("Product not found", 404);
    }

    const { totalStock } = sumStockRows(product.stockLevels);

    return NextResponse.json({ product: { ...product, totalStock } });
  } catch (error) {
    console.error("[PRODUCT_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user, response } = await requirePermission("products:edit");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();
    const result = productSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const existing = await db.product.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Product not found", 404);
    }

    // Check for duplicate SKU (excluding this product)
    if (result.data.sku !== existing.sku) {
      const skuExists = await db.product.findUnique({ where: { sku: result.data.sku } });
      if (skuExists) {
        return fieldError({ sku: ["A product with this SKU already exists"] }, 409);
      }
    }

    const data = result.data;

    let slug = data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const slugConflict = await db.product.findFirst({
      where: { slug, id: { not: id } },
    });
    if (slugConflict) {
      slug = `${slug}-${data.sku.toLowerCase()}`;
    }

    const product = await db.product.update({
      where: { id },
      data: {
        name: data.name,
        slug,
        sku: data.sku,
        // `undefined` (missing) leaves the column untouched; an empty string
        // from the form clears it. Previously a cleared barcode/description
        // could never be erased from a product.
        barcode: data.barcode === undefined ? undefined : data.barcode || null,
        description: data.description === undefined ? undefined : data.description || null,
        categoryId: data.categoryId,
        brandId: data.brandId || null,
        unitPrice: majorToCents(data.unitPrice),
        costPrice: majorToCents(data.costPrice),
        compareAtPrice: data.compareAtPrice != null && data.compareAtPrice > 0 ? majorToCents(data.compareAtPrice) : null,
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
        // Empty conversions clear the column so unit modes can be undone
        unitConversions:
          data.unitConversions && data.unitConversions.length > 0
            ? JSON.stringify(data.unitConversions)
            : data.unitConversions !== undefined
              ? null
              : undefined,
      },
      include: {
        category: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
      },
    });

    logAudit({
      userId: user.id,
      action: "update",
      entity: "product",
      entityId: product.id,
      entityName: product.name,
      newValues: { name: product.name, sku: product.sku, status: product.status },
    });

    return NextResponse.json({ product });
  } catch (error) {
    console.error("[PRODUCT_PUT]", error);
    return apiError("Internal server error", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user, response } = await requirePermission("products:delete");
    if (response) return response;

    const { id } = await params;
    const existing = await db.product.findUnique({ where: { id } });

    if (!existing) {
      return apiError("Product not found", 404);
    }

    // Soft delete
    await db.product.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    logAudit({
      userId: user.id,
      action: "delete",
      entity: "product",
      entityId: existing.id,
      entityName: existing.name,
      oldValues: { name: existing.name, sku: existing.sku },
    });

    return NextResponse.json({ message: "Product deleted" });
  } catch (error) {
    console.error("[PRODUCT_DELETE]", error);
    return apiError("Internal server error", 500);
  }
}
