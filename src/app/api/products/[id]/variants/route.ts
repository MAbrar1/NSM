import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { sumStockRows } from "@/lib/stock-status";
import { majorToCents } from "@/lib/money/money";

/* ═══════════════════════════════════════════════════════════════
   PRODUCT VARIANTS API
   GET    /api/products/[id]/variants — List variants for a product
   POST   /api/products/[id]/variants — Create a new variant
   ═══════════════════════════════════════════════════════════════ */

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** GET — List all variants for a product */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { response } = await requirePermission("products:view");
    if (response) return response;

    const { id } = await params;

    const variants = await db.productVariant.findMany({
      where: { productId: id },
      include: {
        stockLevels: {
          select: { quantity: true, warehouse: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        sku: v.sku,
        barcode: v.barcode,
        unitPrice: v.unitPrice,
        costPrice: v.costPrice,
        imageUrl: v.imageUrl,
        options: v.options,
        isActive: v.isActive,
        totalStock: sumStockRows(v.stockLevels).totalStock,
        createdAt: v.createdAt,
      })),
    });
  } catch (error) {
    console.error("[VARIANTS_GET]", error);
    return NextResponse.json({ variants: [] }, { status: 500 });
  }
}

/** POST — Create a new variant */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { response } = await requirePermission("products:edit");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();

    // Verify product exists
    const product = await db.product.findUnique({ where: { id } });
    if (!product) {
      return apiError("Product not found", 404);
    }

    if (!body.name?.trim()) {
      return apiError("Variant name is required", 400);
    }
    if (!body.sku?.trim()) {
      return apiError("Variant SKU is required", 400);
    }

    // Check SKU uniqueness
    const existingSku = await db.productVariant.findUnique({ where: { sku: body.sku.trim() } });
    if (existingSku) {
      return apiError("A variant with this SKU already exists", 409);
    }

    // Also check product SKU uniqueness
    if (body.sku.trim() === product.sku) {
      return apiError("Variant SKU cannot match the parent product SKU", 409);
    }

    // Parse options from JSON string if needed
    let optionsStr = "{}";
    if (body.options) {
      if (typeof body.options === "string") {
        optionsStr = body.options;
      } else {
        optionsStr = JSON.stringify(body.options);
      }
    }

    const variant = await db.productVariant.create({
      data: {
        productId: id,
        name: body.name.trim(),
        sku: body.sku.trim(),
        barcode: body.barcode?.trim() || null,
        unitPrice: majorToCents(body.unitPrice ?? product.unitPrice),
        costPrice: majorToCents(body.costPrice ?? product.costPrice),
        imageUrl: body.imageUrl?.trim() || null,
        options: optionsStr,
        isActive: body.isActive ?? true,
      },
    });

    return NextResponse.json({ variant }, { status: 201 });
  } catch (error) {
    console.error("[VARIANTS_POST]", error);
    return apiError("Internal server error", 500);
  }
}
