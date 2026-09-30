import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { parsePagination } from "@/lib/api/pagination";
import { sumBaseStock, sumStockRows, stockStatus } from "@/lib/inventory/stock-status";
import { barcodeCandidates } from "@/lib/barcode";

/* ═══════════════════════════════════════════════════════════════
   POS PRODUCT SEARCH API
   GET /api/pos/search?q=...&warehouseId=...&categoryId=...&limit=...
   Fast product lookup by barcode, SKU, or name for the POS terminal.

   CONSISTENCY CONTRACT (must match /api/products):
   - Browse mode (no `q`) returns the FULL active catalog. The route
     auto-pages through the whole table (200 rows per hop) so the POS
     grid can never silently drop products the Products page shows —
     the old single `take: limit` (max 50) truncated the grid at 50
     rows even though the page asked for 100.
   - `totalStock`/`totalReserved`/`totalAvailable` are summed across
     ALL base stock rows of the product (every warehouse, variants
     excluded) via lib/stock-status — exactly like the Products API.
   - `stock`/`reserved`/`available` are scoped to the selected
     warehouse (falling back to the default warehouse when none is
     sent), and `available` floors fractional quantities to whole
     sellable units for non-fractional products (same floor the cart
     and checkout enforce).
   - Variant ("Family Pack") stock rows are reported through the
     variant list and never double-counted into the base product's
     totals, matching what checkout actually decrements.
   ═══════════════════════════════════════════════════════════════ */

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission("pos:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") ?? "";
    const categoryId = searchParams.get("categoryId") ?? undefined;
    const warehouseId = searchParams.get("warehouseId") ?? undefined;
    // `limit` still bounds SEARCH results (ranking quality), but browse
    // mode no longer depends on it — the fetch-all loop below returns
    // every active product regardless of any cap.
    const limit = parsePagination(searchParams, {
      defaultPageSize: 24,
      maxPageSize: 50,
      pageSizeParam: "limit",
    }).pageSize;

    // Build the where clause. An empty query means "browse mode" —
    // return the active catalog (optionally filtered by category).
    const where: Record<string, unknown> = {
      deletedAt: null,
      status: "active",
    };

    if (categoryId) where["categoryId"] = categoryId;

    if (query && query.length >= 1) {
      // Search by barcode (exact match first), then SKU, then name.
      // `mode: "insensitive"` would be non-portable (Postgres-only in
      // older Prisma), so we OR the raw and lower-cased forms which
      // works on SQLite and Postgres alike.
      //
      // Scanned codes also try GTIN-family variants: a hardware reader
      // emits UPC-A (12 digits) while the product may be saved as EAN-13
      // (0-prefixed) — barcodeCandidates() covers UPC-A ↔ EAN-13 ↔
      // GTIN-14 zero-pad mismatches so the scan always resolves.
      const scanCandidates = barcodeCandidates(query).filter((c) => c !== query);
      where["OR"] = [
        { barcode: query },
        // Variant barcodes resolve too — a scan of a "Family Pack" GTIN
        // must surface the parent product (the variant rides along in
        // the payload and the POS adds the exact variant line).
        { variants: { some: { barcode: query } } },
        ...(scanCandidates.length > 0
          ? [
              { barcode: { in: scanCandidates } },
              { variants: { some: { barcode: { in: scanCandidates } } } },
            ]
          : []),
        { sku: { contains: query } },
        { sku: { contains: query.toLowerCase() } },
        { name: { contains: query } },
        { name: { contains: query.toLowerCase() } },
      ];
    }

    // Shared include for both modes — variant rows carry their own stock
    // (sold through the variant SKU); excluding them from stockLevels keeps
    // base-product totals honest — the same rule the checkout uses when
    // decrementing.
    const productInclude = {
      category: { select: { name: true } },
      stockLevels: {
        where: { variantId: null },
        select: {
          quantity: true,
          reservedQuantity: true,
          warehouse: { select: { id: true, name: true, isDefault: true } },
        },
      },
      variants: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          sku: true,
          barcode: true,
          unitPrice: true,
          costPrice: true,
          stockLevels: {
            select: { quantity: true, reservedQuantity: true, warehouse: { select: { id: true } } },
          },
        },
      },
    } satisfies Prisma.ProductInclude;
    type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

    // Browse mode auto-pages through the ENTIRE active catalog so the
    // POS grid always matches the Products page (no silent truncation).
    // Search mode stays capped by `limit` and ranked by match quality.
    const PAGE = 200;
    const products: ProductRow[] = [];
    if (query) {
      products.push(
        ...(await db.product.findMany({
          where,
          include: productInclude,
          take: limit,
          orderBy: [{ barcode: "asc" }, { sku: "asc" }],
        }))
      );
    } else {
      let skip = 0;
      for (;;) {
        const pageRows: ProductRow[] = await db.product.findMany({
          where,
          include: productInclude,
          orderBy: [{ createdAt: "desc" }, { name: "asc" }],
          skip,
          take: PAGE,
        });
        products.push(...pageRows);
        if (pageRows.length < PAGE) break;
        skip += PAGE;
      }
    }

    // Rank search results by match quality so an exact barcode/SKU scan
    // surfaces first even when the query also matches names.
    const ranked = query
      ? [...products].sort((a, b) => {
          const score = (p: (typeof products)[number]) => {
            if (p.barcode && p.barcode === query) return 0;
            if (p.barcode && barcodeCandidates(query).includes(p.barcode)) return 0.5;
            if (p.sku.toLowerCase() === query.toLowerCase()) return 1;
            if (p.sku.toLowerCase().startsWith(query.toLowerCase())) return 2;
            if (p.sku.toLowerCase().includes(query.toLowerCase())) return 3;
            if (p.name.toLowerCase().includes(query.toLowerCase())) return 4;
            return 5;
          };
          return score(a) - score(b) || a.name.localeCompare(b.name);
        })
      : products;

    // Calculate total stock across all warehouses (identical formula to
    // /api/products) plus warehouse-scoped stock for the selected/default
    // warehouse.
    const results = ranked.map((p) => {
      const allStockLevels = p.stockLevels;
      // Shared totals formula (lib/stock-status) — the exact numbers
      // /api/products and /api/products/lookup show for this product.
      const { totalStock, totalReserved, totalAvailable } = sumBaseStock(
        allStockLevels.map((sl) => ({
          quantity: sl.quantity,
          reservedQuantity: sl.reservedQuantity,
        }))
      );

      // Warehouse-specific stock: prefer the requested warehouse, fall
      // back to the store's default warehouse, else 0.
      const whStock =
        (warehouseId ? allStockLevels.find((sl) => sl.warehouse.id === warehouseId) : undefined) ??
        allStockLevels.find((sl) => sl.warehouse.isDefault) ??
        allStockLevels.find((sl) => sl.warehouse.id === warehouseId);
      const warehouseQty = whStock?.quantity ?? 0;
      const warehouseReserved = whStock?.reservedQuantity ?? 0;
      const warehouseName = whStock?.warehouse?.name ?? null;

      // Fractional products (0.9 kg left) can only sell whole base units
      // through the cart — floor so the UI never promises a partial unit.
      const sellableAvailable = p.allowFractional
        ? totalAvailable
        : Math.floor(totalAvailable);
      const sellableWhAvailable = p.allowFractional
        ? warehouseQty - warehouseReserved
        : Math.floor(warehouseQty - warehouseReserved);

      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        description: p.description,
        categoryName: p.category?.name ?? null,
        unitPrice: p.unitPrice,
        costPrice: p.costPrice,
        taxRate: p.taxRate,
        imageUrl: p.imageUrl,
        // Multi-unit metadata — drives the unit-aware quantity dialogs
        unit: p.unit,
        allowFractional: p.allowFractional,
        sellByValue: p.sellByValue,
        unitConversions: p.unitConversions,
        // Totals across every warehouse — same numbers /api/products shows
        totalStock,
        totalReserved,
        totalAvailable: sellableAvailable,
        // Shared stock classification (lib/stock-status) — the same rule
        // the Products/Inventory pages use, so a card marked Low on POS
        // is Low everywhere (replaces the old hardcoded `<= 5`).
        minStockLevel: p.minStockLevel,
        stockStatus: stockStatus(sellableWhAvailable, p.minStockLevel),
        // Warehouse-specific stock (selected or default warehouse)
        warehouseId: warehouseId ?? null,
        warehouseName,
        stock: warehouseQty,
        reserved: warehouseReserved,
        available: sellableWhAvailable,
        // Variants are listed separately so they can never be mistaken
        // for base stock; each carries its own scoped + total figures.
        variants: p.variants.map((v) => {
          // ONE variant's rows summed with the same primitive the product
          // totals use — a variant is not a base row, so sumBaseStock (which
          // filters base rows out) would report zero here.
          const { totalStock: vTotalQty, totalAvailable: vTotalAvailable } =
            sumStockRows(v.stockLevels);
          const vWh = warehouseId
            ? v.stockLevels.find((sl) => sl.warehouse.id === warehouseId)
            : undefined;
          return {
            id: v.id,
            name: v.name,
            sku: v.sku,
            barcode: v.barcode,
            unitPrice: v.unitPrice,
            costPrice: v.costPrice,
            totalStock: vTotalQty,
            totalAvailable: vTotalAvailable,
            stock: vWh?.quantity ?? 0,
            available: (vWh?.quantity ?? 0) - (vWh?.reservedQuantity ?? 0),
          };
        }),
      };
    });

    return NextResponse.json({ products: results });
  } catch (error) {
    console.error("[POS_SEARCH]", error);
    return apiError("Search failed", 500);
  }
}
