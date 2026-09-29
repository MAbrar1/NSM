import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { brandSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api-auth";

/* ═══════════════════════════════════════════════════════════════
   BRANDS API
   GET  /api/brands — List active brands with product counts
   POST /api/brands — Create a new brand (admin only)
   ═══════════════════════════════════════════════════════════════ */

export async function GET() {
  try {
    const { response } = await requirePermission("brands:view");
    if (response) return response;

    const brands = await db.brand.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { products: true } },
      },
    });

    return NextResponse.json({ brands });
  } catch (error) {
    console.error("[BRANDS_GET]", error);
    return apiError("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { response } = await requirePermission("brands:create");
    if (response) return response;

    const body = await request.json();
    const result = brandSchema.safeParse(body);

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
    const existingSlug = await db.brand.findUnique({ where: { slug } });
    if (existingSlug) {
      slug = `${slug}-${Date.now()}`;
    }

    // Check for duplicate name (SQLite: case-sensitive comparison)
    const existingName = await db.brand.findFirst({
      where: { name: data.name },
    });
    if (existingName) {
      return apiError("A brand with this name already exists", 409);
    }

    const brand = await db.brand.create({
      data: {
        name: data.name,
        slug,
        logoUrl: data.logoUrl || undefined,
        isActive: data.isActive,
      },
    });

    return NextResponse.json({ brand }, { status: 201 });
  } catch (error) {
    console.error("[BRANDS_POST]", error);
    return apiError("Internal server error", 500);
  }
}
