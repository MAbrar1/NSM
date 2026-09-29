/* ═══════════════════════════════════════════════════════════════
   PRODUCT LOOKUP API
   GET /api/products/lookup?q=...&ids=a,b,c&limit=...&warehouseId=...
   GET /api/products/lookup?ids=a,b,c → keeps a stable id order

   THE shared catalog source. POS browse/search, the PO line picker,
   product export and any other picker now read the SAME rows with the
   SAME stock formulas (lib/stock-status sumBaseStock) — so the same
   product shows identical price/stock/status on every screen.

   Contract mirrors /api/pos/search (prices in cents; totals across all
   warehouses; warehouse-scoped `available` when warehouseId is sent)
   with the fields pickers need (id/name/sku/barcode/unit/costPrice/
   allowFractional) plus a ready-to-render stockStatus.
   ═══════════════════════════════════════════════════════════════ */

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { parsePagination } from "@/lib/pagination";
import { sumBaseStock, stockStatus, sellableUnits } from "@/lib/stock-status";
import { barcodeCandidates } from "@/lib/barcode";

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("pos:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") ?? "";
    const idsParam = searchParams.get("ids");
    const warehouseId = searchParams.get("warehouseId") ?? undefined;
    const { pageSize: limit } = parsePagination(searchParams, {
      defaultPageSize: 100,
      maxPageSize: 500,
      pageSizeParam: "limit",
    });

    const idList = idsParam
      ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    // `status=low,out` → low-stock strip mode: return low/out rows without
    // a query (used by the POS restock strip). Computed post-fetch because
    // availability depends on the shared stock math, not raw columns.
    const statusFilter = searchParams.get("status");
    const wantLowOut = statusFilter === "low,out" || statusFilter === "out,low";
    if (!query && idList.length === 0 && !wantLowOut) {
      return NextResponse.json({ products: [] });
    }

    const where: Record<string, unknown> = {
      deletedAt: null,
      status: "active",
    };

    if (idList.length > 0) {
      where["id"] = { in: idList };
    } else if (query) {
      // Barcode-first with GTIN-family candidates (UPC-A ↔ EAN-13 ↔
      // GTIN-14 zero-pad variants), then SKU/name contains — portable
      // across SQLite and Postgres (no `mode: "insensitive"`).
      const scanCandidates = barcodeCandidates(query).filter((c) => c !== query);
      where["OR"] = [
        { barcode: query },
        ...(scanCandidates.length > 0 ? [{ barcode: { in: scanCandidates } }] : []),
        { sku: { contains: query } },
        { sku: { contains: query.toLowerCase() } },
        { name: { contains: query } },
        { name: { contains: query.toLowerCase() } },
      ];
    }

    let products = await db.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        sku: true,
        barcode: true,
        description: true,
        imageUrl: true,
        unitPrice: true,
        costPrice: true,
        taxRate: true,
        unit: true,
        allowFractional: true,
        sellByValue: true,
        unitConversions: true,
        minStockLevel: true,
        category: { select: { name: true } },
        brand: { select: { name: true } },
        stockLevels: {
          // Base rows only — variant stock is tracked/sold separately
          // (identical rule to /api/products and /api/pos/search).
          where: { variantId: null },
          select: {
            quantity: true,
            reservedQuantity: true,
            warehouse: { select: { id: true, name: true, isDefault: true } },
          },
        },
      },
      take: limit,
      orderBy: query
        ? [{ barcode: "asc" }, { sku: "asc" }]
        : [{ createdAt: "desc" }, { name: "asc" }],
    });

    // Keep a requested id order stable (pickers rehydrate PO lines etc.)
    if (idList.length > 0) {
      const byId = new Map(products.map((p) => [p.id, p]));
      products = idList
        .map((id) => byId.get(id))
        .filter((p): p is (typeof products)[number] => Boolean(p));
    }

    const results = products
      .map((p) => {
      const rows = p.stockLevels;
      const s = sumBaseStock(
        rows.map((r) => ({ quantity: r.quantity, reservedQuantity: r.reservedQuantity })),
        p.allowFractional
      );
      const wh = warehouseId
        ? rows.find((sl) => sl.warehouse.id === warehouseId)
        : rows.find((sl) => sl.warehouse.isDefault);
      const whQty = wh?.quantity ?? 0;
      const whRes = wh?.reservedQuantity ?? 0;
      // Same convention as /api/pos/search: scoped to the warehouse when
      // one is requested, otherwise the all-warehouse sellable total.
      const available = warehouseId
        ? sellableUnits(whQty - whRes, p.allowFractional)
        : s.sellableAvailable;

      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        description: p.description,
        categoryName: p.category?.name ?? null,
        brandName: p.brand?.name ?? null,
        imageUrl: p.imageUrl,
        unitPrice: p.unitPrice,
        costPrice: p.costPrice,
        taxRate: p.taxRate,
        unit: p.unit,
        allowFractional: p.allowFractional,
        sellByValue: p.sellByValue,
        unitConversions: p.unitConversions,
        minStockLevel: p.minStockLevel,
        totalStock: s.totalStock,
        totalReserved: s.totalReserved,
        totalAvailable: s.totalAvailable,
        available,
        stockStatus: stockStatus(available, p.minStockLevel),
        warehouseId: warehouseId ?? null,
      };
      })
      // Low-stock strip mode: keep only low/out rows, most urgent first.
      .filter((p) =>
        wantLowOut ? p.stockStatus === "low" || p.stockStatus === "out" : true
      )
      .sort((a, b) =>
        wantLowOut
          ? (a.stockStatus === "out" ? 0 : 1) - (b.stockStatus === "out" ? 0 : 1) || a.available - b.available
          : 0
      );

    return NextResponse.json({ products: results });
  } catch (error) {
    console.error("[PRODUCTS_LOOKUP]", error);
    return apiError("Lookup failed", 500);
  }
}
