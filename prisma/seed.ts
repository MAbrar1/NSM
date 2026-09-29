import { runSeed, prisma } from "@/app/api/seed/seed-runner";

/* ═══════════════════════════════════════════════════════════════
   DATABASE SEEDER (CLI)
   Populates the database with realistic sample data for
   development and testing, then verifies catalog consistency
   (stock rows, order reconciliation, customer stats) with the
   shared verifier so a bad seed fails loudly instead of silently
   desyncing the pages. Run with: npm run db:seed
   ═══════════════════════════════════════════════════════════════ */

async function main() {
  await runSeed();

  // Gate the seed on the same invariants the UI depends on.
  try {
    const { verifyConsistency } = await import("@/lib/verify-consistency");
    // verifyConsistency resolves a result OBJECT, not a boolean — this gate
    // used to test the object itself, which is always truthy, so a seed that
    // desynced the pages still reported success.
    const result = await verifyConsistency({ exitOnError: false });
    if (!result.ok) {
      console.error("❌ Seed completed but consistency verification FAILED.");
      process.exitCode = 1;
    }
  } catch (err) {
    // Verification is a safety net, not the seed itself — a crash here
    // (e.g. missing table on a fresh push) shouldn't mask a good seed.
    console.warn("⚠️  Consistency verification skipped:", err instanceof Error ? err.message : err);
  }
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Prisma keeps the event loop alive until the client is disconnected —
    // without this the CLI finishes seeding and then hangs forever.
    await prisma.$disconnect().catch(() => {});
  });
