import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { withApiHandler } from "@/lib/api/api-handler";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   SUPPLIER CSV IMPORT API
   POST /api/suppliers/import — multipart/form-data with a `file`
   field containing CSV (what the Suppliers page sends), or a JSON
   array fallback for API consumers.

   CSV columns (header row required, column order free):
     name*         supplier name (duplicate-checked via slug)
     email         optional (duplicate-checked)
     phone         optional
     address       optional
     city          optional
     country       optional
     taxId         optional (NTN/CNIC)
     paymentTerms  days (default 30)
     rating        1-5 (default 0)
     notes         optional
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

export const POST = withApiHandler("SUPPLIERS_IMPORT", async (request) => {
    const { user, response } = await requirePermission("suppliers:create");
    if (response) return response;

    const contentType = request.headers.get("content-type") ?? "";

    // Normalise everything into rows: [header, ...data]
    let rows: string[][] = [];

    if (contentType.includes("multipart/form-data")) {
      // ── CSV file upload (what the Suppliers page sends) ──
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return apiError("A CSV file is required", 400);
      }
      rows = parseCsv(await file.text());
    } else {
      // ── JSON array fallback for API consumers ──
      const body = (await request.json().catch(() => null)) as
        | { suppliers?: Array<Record<string, unknown>> }
        | null;
      const suppliers = body?.suppliers;
      if (!Array.isArray(suppliers) || suppliers.length === 0) {
        return apiError("Upload a CSV file (multipart/form-data 'file') or send { suppliers: [...] }", 400);
      }
      const HEADER = [
        "name", "email", "phone", "address", "city", "country", "taxId", "paymentTerms", "rating", "notes",
      ];
      rows = [
        HEADER,
        ...suppliers.map((s) => [
          String(s["name"] ?? ""),
          String(s["email"] ?? ""),
          String(s["phone"] ?? ""),
          String(s["address"] ?? ""),
          String(s["city"] ?? ""),
          String(s["country"] ?? ""),
          String(s["taxId"] ?? ""),
          String(s["paymentTerms"] ?? "30"),
          String(s["rating"] ?? "0"),
          String(s["notes"] ?? ""),
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
    const idxCity = idx("city");
    const idxCountry = idx("country");
    const idxTaxId = Math.max(idx("taxid"), idx("tax id"), idx("ntn"), idx("cnic"));
    const idxTerms = Math.max(idx("paymentterms"), idx("payment terms"));
    const idxRating = idx("rating");
    const idxNotes = idx("notes");

    if (idxName === -1) {
      return apiError("CSV must include at least a 'name' column", 400);
    }

    const result: ImportResult = { success: 0, failed: 0, errors: [] };

    const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
    if (dataRows.length > 200) {
      return apiError("Maximum 200 suppliers per import", 400);
    }

    // Preload existing slugs/emails once — O(1) duplicate checks per row
    const [existingSuppliers, existingSlugs] = await Promise.all([
      db.supplier.findMany({
        where: { deletedAt: null, email: { not: null } },
        select: { email: true },
      }),
      db.supplier.findMany({ select: { slug: true } }),
    ]);
    const existingEmails = new Set(
      existingSuppliers.map((s) => s.email?.toLowerCase()).filter(Boolean) as string[]
    );
    const takenSlugs = new Set(existingSlugs.map((s) => s.slug));

    const cell = (r: string[], i: number): string => (i >= 0 && i < r.length ? r[i]!.trim() : "");

    for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
      const r = dataRows[rowIndex]!;
      const rowNum = rowIndex + 2; // +2: header row + 1-based CSV line
      const name = cell(r, idxName);
      const email = cell(r, idxEmail) || undefined;

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

        // Unique slug from name (de-duplicated in-run and against the DB)
        let slug = slugify(name);
        if (!slug) slug = `supplier-${Date.now()}-${rowIndex}`;
        let n = 2;
        while (takenSlugs.has(slug)) {
          slug = `${slugify(name).slice(0, 60)}-${n}`;
          n++;
        }

        const termsRaw = cell(r, idxTerms);
        const paymentTerms = termsRaw ? Math.max(0, Math.floor(Number.parseFloat(termsRaw) || 0)) : 30;
        const ratingRaw = cell(r, idxRating);
        const rating = ratingRaw ? Math.min(5, Math.max(0, Number.parseFloat(ratingRaw) || 0)) : 0;

        await db.supplier.create({
          data: {
            name,
            slug,
            email: email || null,
            phone: cell(r, idxPhone) || null,
            address: cell(r, idxAddress) || null,
            city: cell(r, idxCity) || null,
            country: cell(r, idxCountry) || null,
            taxId: cell(r, idxTaxId) || null,
            paymentTerms: paymentTerms || 30,
            rating,
            notes: cell(r, idxNotes) || null,
          },
        });

        takenSlugs.add(slug);
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
      entity: "supplier",
      entityName: `Bulk import (${result.success} suppliers)`,
      newValues: {
        totalAttempted: dataRows.length,
        successCount: result.success,
        failedCount: result.failed,
      },
    });

    // The client dialog reads `created` / `skipped`
    return NextResponse.json({
      message: `Import complete: ${result.success} created, ${result.failed} failed`,
      created: result.success,
      skipped: result.failed,
      result,
    });
  });
