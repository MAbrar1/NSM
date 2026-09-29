/* ═══════════════════════════════════════════════════════════════
   DATABASE MIGRATE (deploy)
   Applies pending Prisma migrations to the database pointed at by
   DATABASE_URL. Intended for CI/CD and production deploys:

     DATABASE_URL="postgresql://…" npx tsx scripts/db-migrate-deploy.ts

   `prisma migrate deploy` is deliberately used instead of
   `migrate dev`: it never resets data, never runs the generator in
   watch mode, and applies only committed migration files — exactly
   what a production environment needs.

   Exit codes follow the Prisma CLI so CI pipelines can react.
   ═══════════════════════════════════════════════════════════════ */

import { execFileSync } from "child_process";
import path from "path";

function main(): void {
  const url = process.env["DATABASE_URL"];
  if (!url || url.trim() === "") {
    console.error(
      "[db:migrate] DATABASE_URL is not set. Point it at the target database first\n" +
        "            (e.g. postgresql://user:password@host:5432/elite_pos)."
    );
    process.exit(1);
  }

  const prismaBin = path.join("node_modules", ".bin", "prisma");
  console.log(`[db:migrate] Applying pending migrations…`);

  try {
    execFileSync(prismaBin, ["migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
    console.log("[db:migrate] Done.");
  } catch (err) {
    console.error("[db:migrate] Migration deploy failed:", err);
    process.exit(1);
  }
}

main();
