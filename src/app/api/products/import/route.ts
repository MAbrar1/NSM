import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { logAudit } from "@/lib/audit-log";
import { parseMoneyToCents } from "@/lib/money/money";
import { ensureStockRow } from "@/lib/inventory/inventory-service";

/* ═══════════════════════════════════════════════════════════════
   PRODUCT CSV IMPORT API
   POST /api/products/import — multipart/form-data with a `file`
   field containing CSV (the format the Products page exports).

   CSV columns (header row required, column order free):
     name*        product name
     sku*         unique SKU
     barcode      optional
     description  optional
     category*    category NAME (matched case-insensitively; created
                  when missing so an import never dead-ends)
     brand        brand NAME (optional)
     unit         pcs/kg/L... (default pcs)
     price*       unit price in DOLLARS (2 decimals) — the same shape
                  the Products page CSV export produces
     cost         cost price in dollars
     taxRate      percent
     status       active | inactive | discontinued (default active)
     minStock     minimum stock level
   ═══════════════════════════════════════════════════════════════ */

interface ImportResult {
  success: number;
  failed: number;
  errors: Array<{ sku: string; error: string }>;
}

/** Minimal RFC-4180 CSV parser: handles quoted fields, escaped quotes,
 *  \r\n and \n line endings. Returns rows of cell strings. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") {
          cell += "\"";
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  // Final cell/row when the file doesn't end with a newline
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);

  return rows;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export async function POST(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("products:create");
    if (response) return response;

    const contentType = request.headers.get("content-type") ?? "";

    let rows: string[][] = [];

    if (contentType.includes("multipart/form-data")) {
      // ── CSV file upload (what the Products page sends) ──
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return apiError("A CSV file is required", 400);
      }
      const text = await file.text();
      rows = parseCsv(text);
    } else {
      // ── JSON array fallback for API consumers ──
      const body = await request.json().catch(() => null);
      const products = (body as { products?: unknown } | null)?.products;
      if (!Array.isArray(products) || products.length === 0) {
        return apiError("Upload a CSV file (multipart/form-data 'file') or send { products: [...] }", 400);
      }
      rows = [
        ["name", "sku", "barcode", "description", "category", "brand", "unit", "price", "cost", "taxRate", "status", "minStock"],
        ...products.map((p) => {
          const rec = p as Record<string, unknown>;
          return [
            String(rec["name"] ?? ""),
            String(rec["sku"] ?? ""),
            String(rec["barcode"] ?? ""),
            String(rec["description"] ?? ""),
            String(rec["category"] ?? rec["categoryName"] ?? ""),
            String(rec["brand"] ?? rec["brandName"] ?? ""),
            String(rec["unit"] ?? "pcs"),
            String(rec["unitPrice"] ?? ""),
            String(rec["costPrice"] ?? ""),
            String(rec["taxRate"] ?? "0"),
            String(rec["status"] ?? "active"),
            String(rec["minStock"] ?? "5"),
          ];
        }),
      ];
    }

    if (rows.length < 2) {
      return apiError("CSV needs a header row and at least one data row", 400);
    }

    // Header row → column index map (order-free, case-insensitive)
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const col = (name: string): number => header.indexOf(name);

    const idxName = col("name");
    const idxSku = col("sku");
    const idxBarcode = col("barcode");
    const idxDescription = col("description");
    const idxCategory = Math.max(col("category"), col("categoryname"));
    const idxBrand = Math.max(col("brand"), col("brandname"));
    const idxUnit = col("unit");
    const idxPrice = Math.max(col("price"), col("unitprice"));
    const idxCost = col("cost");
    const idxTax = col("taxrate");
    const idxStatus = col("status");
    const idxMinStock = col("minstock");

    if (idxName === -1 || idxSku === -1 || idxPrice === -1 || idxCategory === -1) {
      return apiError("CSV must include at least: name, sku, price, category columns", 400);
    }

    const result: ImportResult = { success: 0, failed: 0, errors: [] };

    // Data rows (cap at 500 per import to keep the request bounded)
    const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
    if (dataRows.length > 500) {
      return apiError("Maximum 500 rows per import", 400);
    }

    // Preload categories/brands once — name lookups stay O(1) per row
    const [categories, brands, defaultWarehouse] = await Promise.all([
      db.category.findMany({ select: { id: true, name: true } }),
      db.brand.findMany({ select: { id: true, name: true } }),
      db.warehouse.findFirst({ where: { isDefault: true } }),
    ]);
    const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
    const brandByName = new Map(brands.map((b) => [b.name.toLowerCase(), b.id]));

    // Existing SKU/slug sets for in-run duplicate detection without a
    // per-row query.
    const existingSku = new Set(
      (await db.product.findMany({ select: { sku: true } })).map((p) => p.sku)
    );
    const existingSlug = new Set(
      (await db.product.findMany({ select: { slug: true } })).map((p) => p.slug)
    );

    for (const r of dataRows) {
      const cell = (i: number): string => (i >= 0 && i < r.length ? r[i]!.trim() : "");
      const name = cell(idxName);
      const sku = cell(idxSku);
      const priceCents = parseMoneyToCents(cell(idxPrice));

      try {
        if (!name || !sku) {
          result.failed++;
          result.errors.push({ sku: sku || "unknown", error: "Missing required fields (name, sku)" });
          continue;
        }
        if (priceCents == null) {
          result.failed++;
          result.errors.push({ sku, error: `Invalid price "${cell(idxPrice)}"` });
          continue;
        }

        const categoryCell = cell(idxCategory);
        let categoryId = categoryByName.get(categoryCell.toLowerCase());
        if (!categoryId && categoryCell) {
          // Auto-create the missing category so the import doesn't dead-end
          let slug = slugify(categoryCell);
          if (existingSlug.has(`cat:${slug}`)) slug = `${slug}-${Date.now()}`;
          const created = await db.category.create({
            data: { name: categoryCell, slug, isActive: true, sortOrder: 999 },
          });
          categoryByName.set(categoryCell.toLowerCase(), created.id);
          existingSlug.add(`cat:${slug}`);
          categoryId = created.id;
        }
        if (!categoryId) {
          result.failed++;
          result.errors.push({ sku, error: "Missing category" });
          continue;
        }

        if (existingSku.has(sku)) {
          result.failed++;
          result.errors.push({ sku, error: "SKU already exists" });
          continue;
        }

        // Slug from name, de-duplicated in-run and against the DB
        let slug = slugify(name);
        if (!slug) slug = sku.toLowerCase();
        while (existingSlug.has(slug)) {
          slug = `${slug}-${sku.toLowerCase().replace(/[^a-z0-9-]/g, "") || Date.now()}`;
        }

        const costCents = parseMoneyToCents(cell(idxCost)) ?? 0;
        const taxRateRaw = cell(idxTax);
        const taxRate = taxRateRaw ? Math.min(100, Math.max(0, Number.parseFloat(taxRateRaw.replace("%", "")) || 0)) : 0;
        const statusCell = cell(idxStatus).toLowerCase();
        const status = ["active", "inactive", "discontinued"].includes(statusCell) ? statusCell : "active";
        const minStockRaw = cell(idxMinStock);
        const minStock = minStockRaw ? Math.max(0, Math.floor(Number.parseFloat(minStockRaw) || 0)) : 5;
        const unit = cell(idxUnit) || "pcs";

        const brandId = brandByName.get(cell(idxBrand).toLowerCase());

        const product = await db.product.create({
          data: {
            name,
            slug,
            sku,
            barcode: cell(idxBarcode) || undefined,
            description: cell(idxDescription) || undefined,
            categoryId,
            brandId: brandId || undefined,
            unitPrice: priceCents,
            costPrice: costCents,
            taxRate,
            status,
            minStockLevel: minStock,
            unit,
            trackInventory: true,
            allowDiscount: true,
          },
        });
        existingSku.add(sku);
        existingSlug.add(slug);

        // Initial stock row in the default warehouse, matching single-product creation
        if (defaultWarehouse) {
          await ensureStockRow(db, {
            productId: product.id,
            warehouseId: defaultWarehouse.id,
          });
        }

        result.success++;
      } catch (error) {
        result.failed++;
        result.errors.push({
          sku: sku || "unknown",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Log the bulk import
    logAudit({
      userId: user.id,
      action: "create",
      entity: "product",
      entityName: `Bulk import (${result.success} products)`,
      newValues: {
        totalAttempted: dataRows.length,
        successCount: result.success,
        failedCount: result.failed,
      },
    });

    // The client toast reads `created` / `skipped`
    return NextResponse.json({
      message: `Import complete: ${result.success} created, ${result.failed} failed`,
      created: result.success,
      skipped: result.failed,
      result,
    });
  } catch (error) {
    console.error("[PRODUCTS_IMPORT]", error);
    return apiError("Internal server error", 500);
  }
}
