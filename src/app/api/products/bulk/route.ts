import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import {
  bulkUpdateProducts,
  validateBulkUpdateInput,
  BulkUpdateError,
} from "@/lib/products/products-bulk";

/* ═══════════════════════════════════════════════════════════════
   PRODUCTS BULK API
   PUT /api/products/bulk — apply one operation to many products.
   Supported fields (any combination in one call):
     • status      → active | inactive | discontinued
     • categoryId  → move products to another category
   ═══════════════════════════════════════════════════════════════ */

export async function PUT(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("products:edit");
    if (response) return response;

    const body = await request.json();
    const input = validateBulkUpdateInput(body);
    const result = await bulkUpdateProducts(input, user.id);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BulkUpdateError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[PRODUCTS_BULK_PUT]", error);
    return apiError("Internal server error", 500);
  }
}
