/* ═══════════════════════════════════════════════════════════════
   DATABASE MIGRATE (status)
   Reports pending/applied migrations without touching the database
   schema — the safe pre-deploy check for CI pipelines:

     DATABASE_URL="postgresql://…" npx tsx scripts/db-migrate-status.ts

   Exits 0 when up to date, 1 when migrations are pending or the
   command fails, so a pipeline can gate deploys on schema readiness.
   ═══════════════════════════════════════════════════════════════ */

import { execFileSync } from "child_process";
import path from "path";

function main(): void {
  const url = process.env["DATABASE_URL"];
  if (!url || url.trim() === "") {
    console.error(
      "[db:status] DATABASE_URL is not set. Point it at the target database first."
    );
    process.exit(1);
  }

  const prismaBin = path.join("node_modules", ".bin", "prisma");

  try {
    execFileSync(prismaBin, ["migrate", "status"], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    console.error("[db:status] Status check failed (or migrations pending):", err);
    process.exit(1);
  }
}

main();
