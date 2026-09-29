/* ═══════════════════════════════════════════════════════════════
   CONSISTENCY VERIFIER (CLI)
   Thin wrapper around the shared core in src/lib/verify-consistency.
   Run after seeding (or any time) with:

       npm run verify

   Exits non-zero when any invariant group has issues, so it can gate
   CI or a deploy.
   ═══════════════════════════════════════════════════════════════ */

import { verifyConsistency } from "../src/lib/verify-consistency";

verifyConsistency({ log: true })
  .then((result) => {
    if (!result.ok) {
      console.error(`\n✖ Consistency verification FAILED (${result.failedGroups} check group(s) had issues)`);
      process.exitCode = 1;
    } else {
      console.log("\n✓ Consistency verification passed — catalog, orders and stats are in sync");
    }
  })
  .catch((err) => {
    console.error("✖ Verifier crashed:", err);
    process.exitCode = 1;
  });
