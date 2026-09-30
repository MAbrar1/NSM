import { NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { categorySchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";

/* ═══════════════════════════════════════════════════════════════
   SINGLE CATEGORY API
   GET    /api/categories/:id — Get category
   PUT    /api/categories/:id — Update category
   DELETE /api/categories/:id — Soft-delete category
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler<{ id: string }>("CATEGORY_GET", async (_request, ctx) => {
    const { response } = await requirePermission("categories:view");
    if (response) return response;

    const { id } = await ctx.params;
    const category = await db.category.findUnique({
      where: { id },
      include: {
        _count: { select: { products: true, children: true } },
        children: {
          select: { id: true, name: true, slug: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    if (!category) {
      return apiError("Category not found", 404);
    }

    return NextResponse.json({ category });
  });

export const PUT = withApiHandler<{ id: string }>("CATEGORY_PUT", async (request, ctx) => {
    const { response } = await requirePermission("categories:edit");
    if (response) return response;

    const { id } = await ctx.params;
    const body = await request.json();
    const result = categorySchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const existing = await db.category.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Category not found", 404);
    }

    const data = result.data;

    // Regenerate slug if name changed
    let slug = existing.slug;
    if (data.name !== existing.name) {
      slug = data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const slugConflict = await db.category.findFirst({
        where: { slug, id: { not: id } },
      });
      if (slugConflict) {
        slug = `${slug}-${Date.now()}`;
      }
    }

    // Prevent self-referencing parent
    if (data.parentId === id) {
      return apiError("A category cannot be its own parent", 400);
    }

    const category = await db.category.update({
      where: { id },
      data: {
        name: data.name,
        slug,
        description: data.description || undefined,
        parentId: data.parentId || undefined,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
    });

    return NextResponse.json({ category });
  });

export const DELETE = withApiHandler<{ id: string }>("CATEGORY_DELETE", async (_request, ctx) => {
    const { response } = await requirePermission("categories:delete");
    if (response) return response;

    const { id } = await ctx.params;
    const existing = await db.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true, children: true } } },
    });

    if (!existing) {
      return apiError("Category not found", 404);
    }

    // Prevent deleting categories with products or children
    if (existing._count.products > 0) {
      return NextResponse.json(
        { error: `Cannot delete category with ${existing._count.products} products. Reassign or remove them first.` },
        { status: 409 }
      );
    }

    if (existing._count.children > 0) {
      return NextResponse.json(
        { error: `Cannot delete category with ${existing._count.children} sub-categories. Remove them first.` },
        { status: 409 }
      );
    }

    await db.category.delete({ where: { id } });

    return NextResponse.json({ message: "Category deleted" });
  });
