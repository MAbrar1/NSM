import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { categorySchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api-auth";

/* ═══════════════════════════════════════════════════════════════
   CATEGORIES API
   GET  /api/categories — List active categories with product counts
   POST /api/categories — Create a new category (admin only)
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    const { response } = await requirePermission("categories:view");
    if (response) return response;

    const categories = await db.category.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        _count: { select: { products: true } },
      },
    });

    return NextResponse.json({ categories });
  } catch (error) {
    console.error("[CATEGORIES_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { response } = await requirePermission("categories:create");
    if (response) return response;

    const body = await request.json();
    const result = categorySchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = result.data;

    // Generate slug from name
    let slug = data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    // Check for slug collision
    const existingSlug = await db.category.findUnique({ where: { slug } });
    if (existingSlug) {
      slug = `${slug}-${Date.now()}`;
    }

    const category = await db.category.create({
      data: {
        name: data.name,
        slug,
        description: data.description || undefined,
        parentId: data.parentId || undefined,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
    });

    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    console.error("[CATEGORIES_POST]", error);
    return apiError("Internal server error", 500);
  }
}
