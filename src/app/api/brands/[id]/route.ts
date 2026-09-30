import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { brandSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";

/* ═══════════════════════════════════════════════════════════════
   SINGLE BRAND API
   GET    /api/brands/:id — Get brand
   PUT    /api/brands/:id — Update brand
   DELETE /api/brands/:id — Soft-delete brand
   ═══════════════════════════════════════════════════════════════ */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("brands:view");
    if (response) return response;

    const { id } = await params;
    const brand = await db.brand.findUnique({
      where: { id },
      include: {
        _count: { select: { products: true } },
        products: {
          where: { deletedAt: null },
          select: { id: true, name: true, sku: true, unitPrice: true, imageUrl: true },
          take: 20,
          orderBy: { name: "asc" },
        },
      },
    });

    if (!brand) {
      return apiError("Brand not found", 404);
    }

    return NextResponse.json({ brand });
  } catch (error) {
    console.error("[BRAND_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("brands:edit");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();
    const result = brandSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const existing = await db.brand.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Brand not found", 404);
    }

    const data = result.data;

    // Regenerate slug if name changed
    let slug = existing.slug;
    if (data.name !== existing.name) {
      slug = data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const slugConflict = await db.brand.findFirst({
        where: { slug, id: { not: id } },
      });
      if (slugConflict) {
        slug = `${slug}-${Date.now()}`;
      }

      // Check duplicate name (SQLite: case-sensitive comparison)
      const nameConflict = await db.brand.findFirst({
        where: {
          name: data.name,
          id: { not: id },
        },
      });
      if (nameConflict) {
        return apiError("A brand with this name already exists", 409);
      }
    }

    const brand = await db.brand.update({
      where: { id },
      data: {
        name: data.name,
        slug,
        logoUrl: data.logoUrl || undefined,
        isActive: data.isActive,
      },
    });

    return NextResponse.json({ brand });
  } catch (error) {
    console.error("[BRAND_PUT]", error);
    return apiError("Internal server error", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("brands:delete");
    if (response) return response;

    const { id } = await params;
    const existing = await db.brand.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });

    if (!existing) {
      return apiError("Brand not found", 404);
    }

    // Prevent deleting brands with products
    if (existing._count.products > 0) {
      return NextResponse.json(
        { error: `Cannot delete brand with ${existing._count.products} products. Reassign or remove them first.` },
        { status: 409 }
      );
    }

    await db.brand.delete({ where: { id } });

    return NextResponse.json({ message: "Brand deleted" });
  } catch (error) {
    console.error("[BRAND_DELETE]", error);
    return apiError("Internal server error", 500);
  }
}
