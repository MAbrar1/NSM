-- ═══════════════════════════════════════════════════════════════
-- PRINT · RECEIPT · SCAN SUBSYSTEM — additive migration
-- New tables: PrinterProfile, Receipt, ReceiptFiscalRecord,
-- ReceiptPrintLog, ProductBarcode, ScanSettings.
-- No existing table is altered except additive FK back-references
-- (handled by Prisma; none change existing columns).
-- ═══════════════════════════════════════════════════════════════

-- ─── PrinterProfile ─────────────────────────────────────────────
CREATE TABLE "PrinterProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "connectionType" TEXT NOT NULL DEFAULT 'browser',
    "connectionTarget" TEXT,
    "paperWidthMm" REAL NOT NULL,
    "printableDots" INTEGER NOT NULL,
    "dpi" INTEGER NOT NULL DEFAULT 203,
    "charsPerLine" INTEGER NOT NULL,
    "codepage" TEXT NOT NULL DEFAULT 'cp437',
    "rasterCommand" TEXT NOT NULL DEFAULT 'gs_v0',
    "bandHeight" INTEGER NOT NULL DEFAULT 256,
    "interBandGapFix" INTEGER NOT NULL DEFAULT 0,
    "feedBeforeCutLines" INTEGER NOT NULL DEFAULT 3,
    "cutMode" TEXT NOT NULL DEFAULT 'full',
    "drawerKick" BOOLEAN NOT NULL DEFAULT false,
    "drawerPin" INTEGER NOT NULL DEFAULT 2,
    "defaultFor" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "PrinterProfile_isEnabled_idx" ON "PrinterProfile"("isEnabled");

-- ─── Receipt ────────────────────────────────────────────────────
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptNo" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "templateVersion" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Receipt_receiptNo_key" ON "Receipt"("receiptNo");
CREATE UNIQUE INDEX "Receipt_orderId_key" ON "Receipt"("orderId");
CREATE INDEX "Receipt_terminalId_issuedAt_idx" ON "Receipt"("terminalId", "issuedAt");
CREATE INDEX "Receipt_issuedAt_idx" ON "Receipt"("issuedAt");

-- ─── ReceiptFiscalRecord (append-only FBR data) ─────────────────
CREATE TABLE "ReceiptFiscalRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "qrPayload" TEXT,
    "fiscalizedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptFiscalRecord_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReceiptFiscalRecord_receiptId_key" ON "ReceiptFiscalRecord"("receiptId");

-- ─── ReceiptPrintLog (append-only, DB-enforced) ─────────────────
CREATE TABLE "ReceiptPrintLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "errorCode" TEXT,
    "userId" TEXT NOT NULL,
    "printerProfileId" TEXT,
    "terminalId" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptPrintLog_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReceiptPrintLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReceiptPrintLog_printerProfileId_fkey" FOREIGN KEY ("printerProfileId") REFERENCES "PrinterProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ReceiptPrintLog_receiptId_createdAt_idx" ON "ReceiptPrintLog"("receiptId", "createdAt");
CREATE INDEX "ReceiptPrintLog_userId_idx" ON "ReceiptPrintLog"("userId");

-- ─── ProductBarcode (multi-barcode / pack barcodes) ─────────────
CREATE TABLE "ProductBarcode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'unit',
    "packQty" REAL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductBarcode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProductBarcode_barcode_key" ON "ProductBarcode"("barcode");
CREATE INDEX "ProductBarcode_productId_idx" ON "ProductBarcode"("productId");

-- ─── ScanSettings (singleton) ───────────────────────────────────
CREATE TABLE "ScanSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "maxGapMs" INTEGER NOT NULL DEFAULT 30,
    "minLength" INTEGER NOT NULL DEFAULT 4,
    "terminatingKey" TEXT NOT NULL DEFAULT 'Enter',
    "prefix" TEXT,
    "suffix" TEXT,
    "debounceMs" INTEGER NOT NULL DEFAULT 300,
    "useEventCode" BOOLEAN NOT NULL DEFAULT true,
    "stripLeakedChars" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── Print-log immutability (DB-enforced, not convention) ───────
-- The log is the audit trail for reprints; nothing may ever rewrite
-- or remove a row. SQLite has no row-level grants, so triggers are
-- the enforcement mechanism.
CREATE TRIGGER "ReceiptPrintLog_no_update"
BEFORE UPDATE ON "ReceiptPrintLog"
BEGIN
    SELECT RAISE(ABORT, 'ReceiptPrintLog is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "ReceiptPrintLog_no_delete"
BEFORE DELETE ON "ReceiptPrintLog"
BEGIN
    SELECT RAISE(ABORT, 'ReceiptPrintLog is append-only: DELETE is forbidden');
END;

-- Backfill: nothing to backfill — all new tables start empty.
