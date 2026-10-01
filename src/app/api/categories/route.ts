import { NextResponse } from "next/server";
import { validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { categorySchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { slugify } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   CATEGORIES API
   GET  /api/categories — List active categories with product counts
   POST /api/categories — Create a new category (admin only)
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler("CATEGORIES_GET", async () => {
    const { response } = await requirePermission("categories:view");
    if (response) return response;

    const categories = await db.category.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        _count: { select: { products: true } },
      },
    });

    return NextResponse.json({ categories });
  });

export const POST = withApiHandler("CATEGORIES_POST", async (request) => {
    const { response } = await requirePermission("categories:create");
    if (response) return response;

    const body = await request.json();
    const result = categorySchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const data = result.data;

    // Generate slug from name
    let slug = slugify(data.name);

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
  });
