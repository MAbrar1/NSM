-- ═══════════════════════════════════════════════════════════════
-- RECEIPT TYPOGRAPHY — Urdu-Indic digits opt-in per store.
-- Additive column on StoreSettings only; receipts already carry the
-- frozen snapshot (urduDigits inside snapshotJson), so historical
-- receipts keep their issued digit style on reprint.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "StoreSettings" ADD COLUMN "receiptUrduDigits" BOOLEAN NOT NULL DEFAULT false;
