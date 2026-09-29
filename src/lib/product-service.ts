/* ═══════════════════════════════════════════════════════════════
   PRODUCT SERVICE — the ONE barcode resolution path.
   POS, inventory, purchase orders and products pages all ask this
   service instead of hand-rolling barcode queries:

   - multi-barcode: ProductBarcode rows + the legacy Product.barcode
   - pack/unit barcodes: kind="pack" rows carry packQty, so a scan
     adds packQty base units (the caller converts)
   - embedded weight/price barcodes: parsed against the configured
     prefix rules, returning the item code + embedded value
   - GTIN candidate expansion (UPC-A ↔ EAN-13 ↔ GTIN-14) reused from
     lib/barcode — one parsing layer for every scan source
   ═══════════════════════════════════════════════════════════════ */

import { db } from "@/lib/db";
import {
  barcodeCandidates,
  parseEmbeddedBarcode,
  type EmbeddedBarcodeConfig,
  type EmbeddedBarcodeData,
} from "@/lib/barcode";

export interface BarcodeMatch {
  productId: string;
  variantId: string | null;
  /** The barcode that matched (for audit/UI display). */
  matchedBarcode: string;
  /** Base units one scan adds (packQty for pack barcodes, else 1). */
  quantity: number;
  /** Embedded value when the barcode carried weight/price (grams/cents). */
  embedded: EmbeddedBarcodeData | null;
}

/**
 * Resolve a raw scanned value to a product (or variant).
 * Server-only (Prisma). Order: exact candidates first (fast path),
 * then multi-barcode table, then embedded weight/price parsing.
 */
export async function findByBarcode(
  rawScan: string,
  opts: { embeddedConfigs?: EmbeddedBarcodeConfig[] } = {}
): Promise<BarcodeMatch | null> {
  const candidates = barcodeCandidates(rawScan);
  if (candidates.length === 0) return null;

  // 1. Legacy Product.barcode + variants (exact IN over candidates).
  const direct = await db.product.findFirst({
    where: { barcode: { in: candidates }, deletedAt: null, status: "active" },
    select: { id: true, barcode: true },
  });
  if (direct?.barcode) {
    return {
      productId: direct.id,
      variantId: null,
      matchedBarcode: direct.barcode,
      quantity: 1,
      embedded: null,
    };
  }

  // 2. Multi-barcode table (unit + pack barcodes) and variant barcodes.
  const rows = await db.productBarcode.findMany({
    where: { barcode: { in: candidates } },
    select: { barcode: true, productId: true, kind: true, packQty: true },
  });
  if (rows.length > 0) {
    const row = rows[0]!;
    return {
      productId: row.productId,
      variantId: null,
      matchedBarcode: row.barcode,
      quantity: row.kind === "pack" ? (row.packQty ?? 1) : 1,
      embedded: null,
    };
  }

  const variants = await db.productVariant.findFirst({
    where: { barcode: { in: candidates }, isActive: true },
    select: { id: true, productId: true, barcode: true },
  });
  if (variants?.barcode) {
    return {
      productId: variants.productId,
      variantId: variants.id,
      matchedBarcode: variants.barcode,
      quantity: 1,
      embedded: null,
    };
  }

  // 3. Embedded weight/price barcodes: strip the embedded value and
  //    look the item code up, returning the embedded data to the caller.
  for (const config of opts.embeddedConfigs ?? []) {
    const parsed = parseEmbeddedBarcode(rawScan, config);
    if (!parsed) continue;
    const embeddedMatches = await db.productBarcode.findMany({
      where: { barcode: parsed.lookupCode, kind: { in: ["unit", "pack"] } },
      select: { barcode: true, productId: true, kind: true, packQty: true },
    });
    const hit =
      embeddedMatches[0] ??
      (await db.product
        .findFirst({
          where: { barcode: parsed.lookupCode, deletedAt: null, status: "active" },
          select: { id: true, barcode: true },
        })
        .then((p) => (p ? { productId: p.id, barcode: p.barcode!, kind: "unit", packQty: null } : null)));
    if (hit) {
      return {
        productId: hit.productId,
        variantId: null,
        matchedBarcode: hit.barcode,
        quantity: hit.kind === "pack" ? (hit.packQty ?? 1) : 1,
        embedded: parsed,
      };
    }
  }

  return null;
}
