import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER CSV IMPORT API
   POST /api/customers/import — multipart/form-data with a `file`
   field containing CSV (what the Customers page sends), or a JSON
   array fallback for API consumers.

   CSV columns (header row required, column order free):
     name*        customer name
     email        optional (duplicate-checked)
     phone        optional
     address      optional
     taxId        optional (NTN/CNIC)
     notes        optional
   ═══════════════════════════════════════════════════════════════ */

interface ImportResult {
  success: number;
  failed: number;
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
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
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

export async function POST(request: NextRequest) {
  try {
    const { user, response } = await requirePermission("customers:create");
    if (response) return response;

    const contentType = request.headers.get("content-type") ?? "";

    // Normalise everything into rows: [header, ...data]
    let rows: string[][] = [];

    if (contentType.includes("multipart/form-data")) {
      // ── CSV file upload (what the Customers page sends) ──
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return apiError("A CSV file is required", 400);
      }
      rows = parseCsv(await file.text());
    } else {
      // ── JSON array fallback for API consumers ──
      const body = (await request.json().catch(() => null)) as
        | { customers?: Array<Record<string, unknown>> }
        | null;
      const customers = body?.customers;
      if (!Array.isArray(customers) || customers.length === 0) {
        return apiError("Upload a CSV file (multipart/form-data 'file') or send { customers: [...] }", 400);
      }
      const HEADER = ["name", "email", "phone", "address", "taxId", "notes"];
      rows = [
        HEADER,
        ...customers.map((c) => [
          String(c["name"] ?? ""),
          String(c["email"] ?? ""),
          String(c["phone"] ?? ""),
          String(c["address"] ?? ""),
          String(c["taxId"] ?? ""),
          String(c["notes"] ?? ""),
        ]),
      ];
    }

    if (rows.length < 2) {
      return apiError("CSV needs a header row and at least one data row", 400);
    }

    // Header row → column index map (order-free, case-insensitive)
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const idx = (name: string): number => header.indexOf(name);
    const idxName = idx("name");
    const idxEmail = idx("email");
    const idxPhone = idx("phone");
    const idxAddress = idx("address");
    const idxTaxId = Math.max(idx("taxid"), idx("tax id"), idx("ntn"), idx("cnic"));
    const idxNotes = idx("notes");

    if (idxName === -1) {
      return apiError("CSV must include at least a 'name' column", 400);
    }

    const result: ImportResult = { success: 0, failed: 0, errors: [] };

    const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
    if (dataRows.length > 200) {
      return apiError("Maximum 200 customers per import", 400);
    }

    // Preload existing active emails once — O(1) duplicate checks per row
    const existingEmails = new Set(
      (await db.customer.findMany({
        where: { isActive: true, email: { not: null } },
        select: { email: true },
      }))
        .map((c) => c.email?.toLowerCase())
        .filter(Boolean) as string[]
    );

    const cell = (r: string[], i: number): string => (i >= 0 && i < r.length ? r[i]!.trim() : "");

    for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
      const r = dataRows[rowIndex]!;
      const rowNum = rowIndex + 2; // +2: header row + 1-based CSV line
      const name = cell(r, idxName);
      const email = cell(r, idxEmail) || undefined;
      const phone = cell(r, idxPhone) || undefined;

      try {
        if (!name) {
          result.failed++;
          result.errors.push({ name: `Row ${rowNum}`, error: "Name is required" });
          continue;
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          result.failed++;
          result.errors.push({ name, error: `Invalid email "${email}"` });
          continue;
        }
        if (email && existingEmails.has(email.toLowerCase())) {
          result.failed++;
          result.errors.push({ name, error: `Email ${email} already exists` });
          continue;
        }

        await db.customer.create({
          data: {
            name,
            email,
            phone,
            address: cell(r, idxAddress) || undefined,
            taxId: cell(r, idxTaxId) || undefined,
            notes: cell(r, idxNotes) || undefined,
            isActive: true,
          },
        });

        if (email) existingEmails.add(email.toLowerCase());
        result.success++;
      } catch (error) {
        result.failed++;
        result.errors.push({
          name: name || `Row ${rowNum}`,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Log the bulk import
    logAudit({
      userId: user.id,
      action: "create",
      entity: "customer",
      entityName: `Bulk import (${result.success} customers)`,
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
    console.error("[CUSTOMERS_IMPORT]", error);
    return apiError("Internal server error", 500);
  }
}
