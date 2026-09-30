import { NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { brandSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";

/* ═══════════════════════════════════════════════════════════════
   BRANDS API
   GET  /api/brands — List active brands with product counts
   POST /api/brands — Create a new brand (admin only)
   ═══════════════════════════════════════════════════════════════ */

export const GET = withApiHandler("BRANDS_GET", async () => {
    const { response } = await requirePermission("brands:view");
    if (response) return response;

    const brands = await db.brand.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { products: true } },
      },
    });

    return NextResponse.json({ brands });
  });

export const POST = withApiHandler("BRANDS_POST", async (request) => {
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
  });
