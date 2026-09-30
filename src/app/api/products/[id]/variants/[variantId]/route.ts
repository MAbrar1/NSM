import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { majorToCents } from "@/lib/money/money";

/* ═══════════════════════════════════════════════════════════════
   SINGLE PRODUCT VARIANT API
   PUT    /api/products/[id]/variants/[variantId] — Update a variant
   DELETE /api/products/[id]/variants/[variantId] — Delete a variant
   ═══════════════════════════════════════════════════════════════ */

interface RouteParams {
  params: Promise<{ id: string; variantId: string }>;
}

/** PUT — Update a variant */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { response } = await requirePermission("products:edit");
    if (response) return response;

    const { id, variantId } = await params;
    const body = await request.json();

    // Verify variant belongs to this product
    const existing = await db.productVariant.findFirst({
      where: { id: variantId, productId: id },
    });
    if (!existing) {
      return apiError("Variant not found", 404);
    }

    // Check SKU uniqueness if changed
    if (body.sku && body.sku.trim() !== existing.sku) {
      const skuTaken = await db.productVariant.findUnique({ where: { sku: body.sku.trim() } });
      if (skuTaken) {
        return apiError("A variant with this SKU already exists", 409);
      }
    }

    let optionsStr: string | undefined;
    if (body.options !== undefined) {
      optionsStr = typeof body.options === "string" ? body.options : JSON.stringify(body.options);
    }

    const variant = await db.productVariant.update({
      where: { id: variantId },
      data: {
        ...(body.name?.trim() && { name: body.name.trim() }),
        ...(body.sku?.trim() && { sku: body.sku.trim() }),
        ...(body.barcode !== undefined && { barcode: body.barcode?.trim() || null }),
        ...(body.unitPrice !== undefined && { unitPrice: majorToCents(body.unitPrice) }),
        ...(body.costPrice !== undefined && { costPrice: majorToCents(body.costPrice) }),
        ...(body.imageUrl !== undefined && { imageUrl: body.imageUrl?.trim() || null }),
        ...(optionsStr !== undefined && { options: optionsStr }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    });

    return NextResponse.json({ variant });
  } catch (error) {
    console.error("[VARIANT_PUT]", error);
    return apiError("Internal server error", 500);
  }
}

/** DELETE — Remove a variant */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { response } = await requirePermission("products:edit");
    if (response) return response;

    const { id, variantId } = await params;

    // Verify variant belongs to this product
    const existing = await db.productVariant.findFirst({
      where: { id: variantId, productId: id },
    });
    if (!existing) {
      return apiError("Variant not found", 404);
    }

    // Check if variant has any order history
    const orderItemCount = await db.orderItem.count({
      where: { variantId },
    });
    if (orderItemCount > 0) {
      return apiError("Cannot delete variant with order history. Deactivate it instead.", 409);
    }

    // Delete associated stock levels first
    await db.stockLevel.deleteMany({ where: { variantId } });
    await db.productVariant.delete({ where: { id: variantId } });

    return NextResponse.json({ message: "Variant deleted" });
  } catch (error) {
    console.error("[VARIANT_DELETE]", error);
    return apiError("Internal server error", 500);
  }
}
