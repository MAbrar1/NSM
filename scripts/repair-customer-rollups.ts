/* ═══════════════════════════════════════════════════════════════
   REPAIR CUSTOMER ROLLUPS (CLI)
   Rebuilds every customer's denormalized stats from the order ledger:
   totalSpent, orderCount, loyaltyPoints and outstandingBalance.

   Use it when those columns have drifted from the orders — e.g. a
   partially completed seed left lifetime spend and khata balances at 0
   while the orders themselves are intact. Idempotent, so it is safe to
   run again; a clean database reports "nothing to repair".

       npm run repair:rollups

   Follow it with `npm run verify` — checks 5 (customer stats) and 7
   (khata balances) should both pass.
   ═══════════════════════════════════════════════════════════════ */

import { PrismaClient } from "@prisma/client";
import { recomputeCustomerRollups } from "../src/lib/customer-rollups";

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log("Recomputing customer rollups from the order ledger...\n");
    const result = await recomputeCustomerRollups(prisma, { log: true });

    if (result.changed === 0) {
      console.log(`\n✓ All ${result.checked} customers already match the ledger — nothing to repair`);
    } else {
      console.log(
        `\n✓ Repaired ${result.changed} of ${result.checked} customers (${result.withDues} still owe on open credit orders)`
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("✖ Repair failed:", err);
  process.exitCode = 1;
});
