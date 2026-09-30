import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { supplierPurchaseStats } from "@/lib/suppliers/supplier-stats";

/* ═══════════════════════════════════════════════════════════════
   SINGLE SUPPLIER API
   GET    /api/suppliers/:id  — Get supplier with products & POs
   PUT    /api/suppliers/:id  — Update supplier
   DELETE /api/suppliers/:id  — Soft-delete supplier
   ═══════════════════════════════════════════════════════════════ */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("suppliers:view");
    if (response) return response;

    const { id } = await params;
    const supplier = await db.supplier.findUnique({
      where: { id },
      include: {
        products: {
          where: { deletedAt: null },
          select: { id: true, name: true, sku: true, unitPrice: true, imageUrl: true },
          take: 20,
        },
        purchaseOrders: {
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { items: true },
        },
        _count: { select: { products: true, purchaseOrders: true } },
      },
    });

    if (!supplier) {
      return apiError("Supplier not found", 404);
    }

    const { totalSpent } = supplierPurchaseStats(supplier.purchaseOrders);

    return NextResponse.json({
      supplier: { ...supplier, stats: { totalSpent } },
    });
  } catch (error) {
    console.error("GET /api/suppliers/[id] error:", error);
    return apiError("Failed to fetch supplier", 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("suppliers:edit");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();
    const { name, email, phone, address, city, country, taxId, paymentTerms, rating, notes, isActive } = body;

    const existing = await db.supplier.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Supplier not found", 404);
    }

    // Check email uniqueness
    if (email && email !== existing.email) {
      const dupEmail = await db.supplier.findFirst({
        where: { email, deletedAt: null, id: { not: id } },
      });
      if (dupEmail) {
        return fieldError({ email: ["Email already in use"] }, 409);
      }
    }

    // Regenerate slug if name changed
    let slug = existing.slug;
    if (name && name !== existing.name) {
      slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const dupSlug = await db.supplier.findFirst({
        where: { slug, id: { not: id } },
      });
      if (dupSlug) {
        slug = `${slug}-${Date.now()}`;
      }
    }

    const supplier = await db.supplier.update({
      where: { id },
      data: {
        ...(name && { name, slug }),
        ...(email !== undefined && { email: email || null }),
        ...(phone !== undefined && { phone: phone || null }),
        ...(address !== undefined && { address: address || null }),
        ...(city !== undefined && { city: city || null }),
        ...(country !== undefined && { country: country || null }),
        ...(taxId !== undefined && { taxId: taxId || null }),
        ...(paymentTerms !== undefined && { paymentTerms }),
        ...(rating !== undefined && { rating }),
        ...(notes !== undefined && { notes: notes || null }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    return NextResponse.json({ supplier });
  } catch (error) {
    console.error("PUT /api/suppliers/[id] error:", error);
    return apiError("Failed to update supplier", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("suppliers:delete");
    if (response) return response;

    const { id } = await params;
    const existing = await db.supplier.findUnique({ where: { id } });
    if (!existing) {
      return apiError("Supplier not found", 404);
    }

    // Check for active POs
    const activePOs = await db.purchaseOrder.count({
      where: {
        supplierId: id,
        status: { in: ["draft", "pending", "ordered", "partial"] },
      },
    });

    if (activePOs > 0) {
      return apiError("Cannot delete supplier with active purchase orders", 409);
    }

    await db.supplier.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/suppliers/[id] error:", error);
    return apiError("Failed to delete supplier", 500);
  }
}
