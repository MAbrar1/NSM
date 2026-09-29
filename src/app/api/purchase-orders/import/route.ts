import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";
import { parseMoneyToCents } from "@/lib/money";
import { poLineTotals, poTotals } from "@/lib/purchase-order-math";

/* ═══════════════════════════════════════════════════════════════
   PURCHASE ORDER CSV IMPORT API
   POST /api/purchase-orders/import — multipart/form-data with a
   `file` field containing CSV, or a JSON fallback.

   Each CSV row becomes ONE PO LINE. Consecutive rows with the same
   supplier name are grouped into a single draft PO (blank supplier
   cell = same PO as the previous row), so a 40-line restock is one
   40-line import.

   CSV columns (header row required, column order free):
     supplier*     supplier NAME (matched case-insensitively)
     sku*          product SKU (must exist — no product creation here)
     quantity*     ordered quantity (decimals allowed for kg/L)
     unitCost      cost per unit in DOLLARS (defaults to the
                   product's current costPrice when blank)
     taxRate       percent per line (default 0)
     warehouse     warehouse CODE or NAME (default: the store's
                   default warehouse)
     expectedDate  YYYY-MM-DD
     notes         PO-level note (taken from the first line of a PO)
   ═══════════════════════════════════════════════════════════════ */

interface ImportResult {
  success: number; // purchase orders created
  failed: number; // rows rejected
  linesCreated: number; // individual PO lines written
  errors: Array<{ name: string; error: string }>;
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
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);

  return rows;
}

/** Allocate a unique PO number with retry (mirrors POST /api/purchase-orders). */
async function allocatePoNumber(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.purchaseOrder.count();
    const candidate = `PO-${String(count + 1).padStart(6, "0")}`;
    const clash = await db.purchaseOrder.findUnique({ where: { orderNumber: candidate } });
    if (!clash) return candidate;
  }
  return `PO-IMP-${Date.now()}`;
}

interface GroupedLine {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitCost: number;
  taxRate: number;
}

interface GroupedPO {
  supplierId: string;
  warehouseId: string;
  expectedDate: Date | null;
  notes: string | null;
  lines: GroupedLine[];
}

export async function POST(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("purchase_orders:create");
    if (response) return response;

    const contentType = request.headers.get("content-type") ?? "";

    let rows: string[][] = [];

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return apiError("A CSV file is required", 400);
      }
      rows = parseCsv(await file.text());
    } else {
      // JSON fallback: { lines: [{ supplier, sku, quantity, unitCost?, taxRate?, warehouse?, expectedDate?, notes? }] }
      const body = (await request.json().catch(() => null)) as
        | { lines?: Array<Record<string, unknown>> }
        | null;
      const lines = body?.lines;
      if (!Array.isArray(lines) || lines.length === 0) {
        return apiError("Upload a CSV file (multipart/form-data 'file') or send { lines: [...] }", 400);
      }
      const HEADER = ["supplier", "sku", "quantity", "unitCost", "taxRate", "warehouse", "expectedDate", "notes"];
      rows = [
        HEADER,
        ...lines.map((l) => [
          String(l["supplier"] ?? ""),
          String(l["sku"] ?? ""),
          String(l["quantity"] ?? ""),
          String(l["unitCost"] ?? ""),
          String(l["taxRate"] ?? "0"),
          String(l["warehouse"] ?? ""),
          String(l["expectedDate"] ?? ""),
          String(l["notes"] ?? ""),
        ]),
      ];
    }

    if (rows.length < 2) {
      return apiError("CSV needs a header row and at least one data row", 400);
    }

    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const idx = (name: string): number => header.indexOf(name);
    const idxSupplier = idx("supplier");
    const idxSku = idx("sku");
    const idxQty = idx("quantity");
    const idxCost = Math.max(idx("unitcost"), idx("unit cost"), idx("cost"));
    const idxTax = Math.max(idx("taxrate"), idx("tax rate"));
    const idxWarehouse = idx("warehouse");
    const idxExpected = Math.max(idx("expecteddate"), idx("expected date"));
    const idxNotes = idx("notes");

    if (idxSupplier === -1 || idxSku === -1 || idxQty === -1) {
      return apiError("CSV must include at least: supplier, sku, quantity columns", 400);
    }

    const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
    if (dataRows.length > 500) {
      return apiError("Maximum 500 lines per import", 400);
    }

    // Preload every lookup once — supplier/warehouse/product maps stay O(1)
    const [suppliers, warehouses, products, defaultWarehouse] = await Promise.all([
      db.supplier.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
      db.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
      db.product.findMany({
        select: { id: true, name: true, sku: true, costPrice: true, allowFractional: true },
      }),
      db.warehouse.findFirst({ where: { isDefault: true } }),
    ]);

    const supplierByName = new Map(suppliers.map((s) => [s.name.toLowerCase(), s.id]));
    const warehouseByKey = new Map<string, string>();
    for (const w of warehouses) {
      warehouseByKey.set(w.code.toLowerCase(), w.id);
      warehouseByKey.set(w.name.toLowerCase(), w.id);
    }
    const productBySku = new Map(products.map((p) => [p.sku.toLowerCase(), p]));

    const result: ImportResult = { success: 0, failed: 0, linesCreated: 0, errors: [] };

    const cell = (r: string[], i: number): string => (i >= 0 && i < r.length ? r[i]!.trim() : "");

    // ── Parse + group rows into POs ──
    const groups: GroupedPO[] = [];
    let current: GroupedPO | null = null;

    for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
      const r = dataRows[rowIndex]!;
      const rowNum = rowIndex + 2;
      const sku = cell(r, idxSku);
      const product = productBySku.get(sku.toLowerCase());

      try {
        // Blank supplier continues the previous PO (multi-line restock).
        const supplierCell = cell(r, idxSupplier);
        if (supplierCell) {
          const supplierId = supplierByName.get(supplierCell.toLowerCase());
          if (!supplierId) {
            result.failed++;
            result.errors.push({ name: `Row ${rowNum} (${sku || "—"})`, error: `Supplier "${supplierCell}" not found` });
            continue;
          }
          // New PO group
          const warehouseCell = cell(r, idxWarehouse);
          let warehouseId = warehouseCell ? (warehouseByKey.get(warehouseCell.toLowerCase()) ?? null) : null;
          if (!warehouseId) warehouseId = defaultWarehouse?.id ?? null;
          if (!warehouseId) {
            result.failed++;
            result.errors.push({ name: `Row ${rowNum} (${sku || "—"})`, error: "No warehouse available" });
            continue;
          }
          const expectedRaw = cell(r, idxExpected);
          const parsedDate = expectedRaw ? new Date(expectedRaw) : null;
          current = {
            supplierId,
            warehouseId,
            expectedDate: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
            notes: cell(r, idxNotes) || null,
            lines: [],
          };
          groups.push(current);
        } else if (!current) {
          result.failed++;
          result.errors.push({ name: `Row ${rowNum} (${sku || "—"})`, error: "First row must include a supplier" });
          continue;
        }
        const group = current!;

        if (!product) {
          result.failed++;
          result.errors.push({ name: `Row ${rowNum} (${sku || "—"})`, error: `SKU "${sku}" not found` });
          continue;
        }
        const qty = Number.parseFloat(cell(r, idxQty));
        if (!Number.isFinite(qty) || qty <= 0) {
          result.failed++;
          result.errors.push({ name: `Row ${rowNum} (${sku})`, error: `Invalid quantity "${cell(r, idxQty)}"` });
          continue;
        }
        if (!product.allowFractional && !Number.isInteger(qty)) {
          result.failed++;
          result.errors.push({ name: `Row ${rowNum} (${sku})`, error: "Fractional quantity not allowed for this product" });
          continue;
        }
        // Blank unit cost → the product's current cost price
        const costCell = cell(r, idxCost);
        const unitCost = costCell ? parseMoneyToCents(costCell) : product.costPrice;
        if (unitCost == null) {
          result.failed++;
          result.errors.push({ name: `Row ${rowNum} (${sku})`, error: `Invalid unit cost "${costCell}"` });
          continue;
        }
        const taxRaw = cell(r, idxTax);
        const taxRate = taxRaw ? Math.min(100, Math.max(0, Number.parseFloat(taxRaw.replace("%", "")) || 0)) : 0;

        group.lines.push({
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          quantity: qty,
          unitCost,
          taxRate,
        });
        result.linesCreated++;
      } catch (error) {
        result.failed++;
        result.errors.push({
          name: `Row ${rowNum} (${sku || "—"})`,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    if (groups.length > 100) {
      return apiError("Maximum 100 purchase orders per import", 400);
    }

    // ── Create the POs (each with its items in one transaction-like create) ──
    for (const g of groups) {
      try {
        const { subtotal, taxAmount, total } = poTotals(g.lines);
        const items = g.lines.map((l) => ({
          ...l,
          total: poLineTotals(l).lineTotalWithTax,
        }));

        const orderNumber = await allocatePoNumber();
        await db.purchaseOrder.create({
          data: {
            orderNumber,
            supplierId: g.supplierId,
            warehouseId: g.warehouseId,
            status: "draft",
            subtotal,
            taxAmount,
            shippingCost: 0,
            total,
            notes: g.notes,
            expectedDate: g.expectedDate,
            createdById: user.id,
            items: {
              create: items.map((l) => ({
                productId: l.productId,
                productName: l.productName,
                sku: l.sku,
                quantity: l.quantity,
                unitCost: l.unitCost,
                taxRate: l.taxRate,
                total: l.total,
              })),
            },
          },
        });
        result.success++;
      } catch (error) {
        result.failed += g.lines.length;
        result.errors.push({
          name: `PO for ${g.lines[0]?.sku ?? "?"} (+${g.lines.length - 1} lines)`,
          error: error instanceof Error ? error.message : "Failed to create purchase order",
        });
      }
    }

    logAudit({
      userId: user.id,
      action: "create",
      entity: "purchase_order",
      entityName: `Bulk import (${result.success} purchase orders, ${result.linesCreated} lines)`,
      newValues: {
        totalAttempted: dataRows.length,
        successCount: result.success,
        failedCount: result.failed,
        linesCreated: result.linesCreated,
      },
    });

    return NextResponse.json({
      message: `Import complete: ${result.success} purchase orders (${result.linesCreated} lines), ${result.failed} failed`,
      created: result.success,
      skipped: result.failed,
      result,
    });
  } catch (error) {
    console.error("[PO_IMPORT]", error);
    return apiError("Internal server error", 500);
  }
}
