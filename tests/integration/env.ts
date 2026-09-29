/* ═══════════════════════════════════════════════════════════════
   INTEGRATION-TEST ENV — MUST BE THE FIRST IMPORT IN TEST FILES.

   Sets DATABASE_URL to a unique temp SQLite file BEFORE any module
   that constructs a PrismaClient is evaluated. ESM evaluates static
   imports depth-first in declaration order, so:

     import "./integration/env";    // ← sets the env var first
     import { db } from "@/lib/db"; // ← client sees the temp URL

   This is the only safe way to point the in-process client at the
   test database: the client resolves env DATABASE_URL at
   construction, so setting it later (inside a setup() body) is
   too late — the client would silently keep pointing at .env's
   database. That exact failure deleted dev data once; never again.
   ═══════════════════════════════════════════════════════════════ */

import { mkdtempSync } from "fs";
import os from "os";
import path from "path";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "elite-pos-it-"));
const dbFile = path.join(tempDir, "test.db");

const url =
  process.platform === "win32"
    ? "file:" + dbFile.replace(/\\/g, "/")
    : "file:" + dbFile;

process.env["DATABASE_URL"] = url;

/** Location of the throwaway test database (for cleanup + assertions). */
export const TEST_DB_FILE = dbFile;

/** The temp directory holding it — rm -rf this to tear down. */
export const TEST_DB_DIR = tempDir;
