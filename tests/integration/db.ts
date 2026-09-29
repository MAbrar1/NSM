/* ═══════════════════════════════════════════════════════════════
   INTEGRATION TEST HARNESS
   Uses the throwaway SQLite database set up by ./env (which MUST be
   imported before anything else), pushes the schema into it, and
   provides table cleanup between tests.

   Safety belts (learned the hard way):
   1. The schema is pushed with DATABASE_URL pointing at the temp
      file inside the child process too.
   2. cleanTables() refuses to run when the connected database is
      NOT the temp file — if the client ever points at .env's dev
      database, tests fail loudly instead of deleting real data.
   ═══════════════════════════════════════════════════════════════ */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { rm, readFile, writeFile, mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { TEST_DB_FILE, TEST_DB_DIR } from "./env";
import { db } from "@/lib/db";

let schemaFile: string | null = null;

/**
 * Push the Prisma schema into the temp database. Call once in a
 * before() hook. Never touches the project's dev database: the child
 * process gets DATABASE_URL explicitly, and the schema copy's
 * datasource url is hard-patched to the temp file.
 */
export async function setupTestDb(): Promise<{ dbFile: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "elite-pos-schema-"));
  schemaFile = path.join(dir, "schema.prisma");

  const sourceSchema = path.resolve("prisma/schema.prisma");
  const schemaText = await readFile(sourceSchema, "utf8");
  const url = TEST_DB_FILE.replace(/\\/g, "/");
  const patched = schemaText.replace(
    /url\s*=\s*env\("DATABASE_URL"\)/,
    `url = "file:${url}"`
  );
  await writeFile(schemaFile, patched, "utf8");

  execFileSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "db",
      "push",
      "--skip-generate",
      "--accept-data-loss",
      "--schema",
      schemaFile,
    ],
    {
      stdio: "pipe",
      timeout: 120_000,
      env: { ...process.env, DATABASE_URL: `file:${url}` },
    }
  );

  // `db push` syncs tables but NOT the raw-SQL triggers our migration
  // adds (print-log immutability). Apply any trigger statements from
  // the repo's migrations so the test DB matches production behavior.
  await applyMigrationsTriggers();

  return { dbFile: TEST_DB_FILE };
}

/** Execute the trigger statements from prisma/migrations in order. */
async function applyMigrationsTriggers(): Promise<void> {
  const migrationsDir = path.resolve("prisma/migrations");
  let entries: string[] = [];
  try {
    entries = (await import("fs")).readdirSync(migrationsDir).sort();
  } catch {
    return; // no migrations dir — nothing to apply
  }
  for (const dir of entries) {
    const sqlPath = path.join(migrationsDir, dir, "migration.sql");
    try {
      const sql = readFileSync(sqlPath, "utf8");
      for (const trigger of extractTriggerStatements(sql)) {
        await db.$executeRawUnsafe(trigger);
      }
    } catch {
      // missing file / already applied / dialect issue — skip
    }
  }
}

/** Pull complete CREATE TRIGGER …END; blocks out of a migration file. */
function extractTriggerStatements(sql: string): string[] {
  const out: string[] = [];
  const lines = sql.split("\n");
  let buf: string[] | null = null;
  for (const line of lines) {
    if (buf === null && /CREATE\s+TRIGGER/i.test(line)) {
      buf = [line];
    } else if (buf !== null) {
      buf.push(line);
      if (/^END;\s*$/i.test(line.trim())) {
        out.push(buf.join("\n"));
        buf = null;
      }
    }
  }
  return out;
}

/** Delete the temp database directory. Safe to call twice.
 *  The Prisma client must disconnect first — on Windows an open
 *  SQLite handle makes unlink fail with EBUSY. */
export async function teardownTestDb(): Promise<void> {
  await db.$disconnect().catch(() => {});
  await rm(TEST_DB_DIR, { recursive: true, force: true });
  if (schemaFile) {
    await rm(path.dirname(schemaFile), { recursive: true, force: true });
  }
}

/** Guard: the connected file must be the temp test database. */
async function assertTestDatabase(): Promise<void> {
  const row = await db.$queryRaw<{ file: string }[]>`PRAGMA database_list`;
  const file = row.find((r) => r.file)?.file ?? "";
  const expected = TEST_DB_FILE.replace(/\\/g, "/").toLowerCase();
  const actual = file.replace(/\\/g, "/").toLowerCase();
  if (!actual || actual !== expected) {
    throw new Error(
      `SAFETY ABORT: Prisma client is connected to "${actual || "(memory)"}", ` +
        `not the test database "${expected}". Refusing to run destructive ` +
        `cleanup against a real database.`
    );
  }
}

/**
 * Wipe every table between tests. Order matters — children first.
 * Refuses to touch anything but the temp test database.
 */
export async function cleanTables(): Promise<void> {
  await assertTestDatabase();
  // The append-only print-log trigger would block its own cleanup;
  // drop, wipe, re-apply — mirroring an admin-only maintenance path.
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "ReceiptPrintLog_no_update"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "ReceiptPrintLog_no_delete"`);
  await db.cartItem.deleteMany();
  await db.payment.deleteMany();
  await db.orderItem.deleteMany();
  // Receipt rows reference orders — children first.
  await db.receiptPrintLog.deleteMany();
  await db.receiptFiscalRecord.deleteMany();
  await db.receipt.deleteMany();
  await db.printerProfile.deleteMany();
  await db.productBarcode.deleteMany();
  await db.scanSettings.deleteMany();
  await db.order.deleteMany();
  await db.inventoryMovement.deleteMany();
  await db.stockLevel.deleteMany();
  await db.productVariant.deleteMany();
  await db.product.deleteMany();
  await db.brand.deleteMany();
  await db.category.deleteMany();
  await db.customer.deleteMany();
  await db.auditLog.deleteMany();
  await db.warehouse.deleteMany();
  await db.user.deleteMany();
  // Re-apply the immutability triggers for the next test.
  await applyMigrationsTriggers();
}

export { db };
