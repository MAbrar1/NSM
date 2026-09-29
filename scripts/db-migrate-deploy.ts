import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/* ═══════════════════════════════════════════════════════════════
   DB MIGRATE DEPLOY (SQLite-aware)
   docs/DATABASE-MIGRATIONS.md routes production at
   `tsx scripts/db-migrate-deploy.ts`. Prisma's `migrate deploy`
   is not available for SQLite in this workspace layout, so the
   script applies pending migration SQL files directly and records
   them in Prisma's own `_prisma_migrations` bookkeeping table —
   same semantics (idempotent, timestamp-ordered, one row per
   migration) without the provider restriction.
   ═══════════════════════════════════════════════════════════════ */

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

interface Applied {
  migration_name: string;
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  try {
    // The bookkeeping table exists in every Prisma-managed database.
    // Create it defensively so a fresh SQLite file works too.
    await db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )`
    );

    const applied = (await db.$queryRawUnsafe<Applied[]>(
      `SELECT migration_name FROM "_prisma_migrations"
       WHERE rolled_back_at IS NULL ORDER BY migration_name ASC`
    )) as Applied[];
    const appliedNames = new Set(applied.map((a) => a.migration_name));

    if (!existsSync(MIGRATIONS_DIR)) {
      console.error("[db-migrate-deploy] No prisma/migrations directory found.");
      process.exit(1);
    }

    const dirs = readdirSorted(MIGRATIONS_DIR);
    let pending = 0;

    // Baseline reconciliation: `prisma db push` (the dev workflow) may
    // have already created this migration's tables. Detect the first
    // table each migration would create; if it exists, record the
    // migration as applied instead of failing on "already exists".
    const FIRST_TABLE: Record<string, string> = {
      "20260929120000_print_receipt_scan": "PrinterProfile",
    };

    for (const dir of dirs) {
      if (appliedNames.has(dir)) continue;

      const sentinel = FIRST_TABLE[dir];
      if (sentinel) {
        const exists = (await db.$queryRawUnsafe<{ name: string }[]>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
          sentinel
        )) as { name: string }[];
        if (exists.length > 0) {
          const checksum = Buffer.from(readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8")).toString("base64");
          await db.$executeRawUnsafe(
            `INSERT INTO "_prisma_migrations"
             ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
             VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
            crypto.randomUUID(), checksum, dir
          );
          console.log(`[db-migrate-deploy] ✓ ${dir} (baseline: tables already present)`);
          continue;
        }
      }

      const sqlPath = join(MIGRATIONS_DIR, dir, "migration.sql");
      if (!existsSync(sqlPath)) {
        console.warn(`[db-migrate-deploy] Skipping "${dir}" — no migration.sql`);
        continue;
      }

      const sql = readFileSync(sqlPath, "utf8");
      const checksum = Buffer.from(sql).toString("base64");
      pending++;

      console.log(`[db-migrate-deploy] Applying ${dir} …`);
      try {
        // Statement-by-statement: SQLite's driver executes one statement
        // per call, and triggers contain embedded semicolons that a
        // naive split would break. Split on semicolons that are not
        // inside a BEGIN…END trigger body by executing the whole file
        // through executescript-equivalent: SQLite drivers here accept
        // multi-statement strings via $executeRawUnsafe? They do not —
        // so split, but keep trigger bodies intact by splitting on
        // ";\n" boundaries only outside BEGIN…END.
        for (const stmt of splitStatements(sql)) {
          const trimmed = stmt.trim();
          if (!trimmed || trimmed.startsWith("--")) continue;
          await db.$executeRawUnsafe(trimmed);
        }
      } catch (err) {
        console.error(`[db-migrate-deploy] FAILED in ${dir}:`, err);
        process.exit(1);
      }

      await db.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations"
         ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
         VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
        crypto.randomUUID(),
        checksum,
        dir
      );
      console.log(`[db-migrate-deploy] ✓ ${dir}`);
    }

    if (pending === 0) console.log("[db-migrate-deploy] Database is up to date.");
    else console.log(`[db-migrate-deploy] Applied ${pending} migration(s).`);
  } finally {
    await db.$disconnect();
  }
}

/** Sorted directory names (timestamped prefixes give apply order). */
function readdirSorted(dir: string): string[] {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/**
 * Split a migration file into statements without breaking trigger
 * bodies: split on `;` that are followed by a newline and NOT inside
 * a BEGIN…END block. The trigger bodies in our migrations end with
 * `END;` on its own line, so a simple state machine over lines works.
 */
function splitStatements(sql: string): string[] {
  const lines = sql.split("\n");
  const out: string[] = [];
  let buf = "";
  let depth = 0; // BEGIN…END nesting (triggers)

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper.startsWith("BEGIN")) depth++;
    buf += line + "\n";
    // A statement ends at a line that is exactly ";" or ends with ";"
    // while depth === 0. `END;` decrements depth first.
    if (upper === "END;" || upper.startsWith("END;")) depth = Math.max(0, depth - 1);
    const endsStatement = depth === 0 && line.trimEnd().endsWith(";");
    if (endsStatement && depth === 0) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

main().catch((err) => {
  console.error("[db-migrate-deploy]", err);
  process.exit(1);
});
