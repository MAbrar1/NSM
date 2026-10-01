/* ═══════════════════════════════════════════════════════════════
   CLEAR LOGIN ATTEMPTS (CLI)

   The login lockout (src/lib/rate-limit.ts) is database-backed: after
   MAX_FAILED_PER_EMAIL failures an email is locked for 15 minutes, and
   heavy traffic is throttled per IP. Rows are pruned opportunistically
   and by the periodic maintenance sweep — but sometimes an operator
   needs the rows gone NOW (locked out of their own store, or a noisy
   test run). This CLI is that escape hatch, and it never touches any
   other table.

   Usage:
     npm run clear:login-attempts                    # prune rows older than 24h (default)
     npm run clear:login-attempts -- --email a@b.c   # unlock one account immediately
     npm run clear:login-attempts -- --all           # wipe every attempt row

   Notes:
   - Safe to run while the app is serving: it only deletes rows, and the
     limiter re-derives its state from whatever remains.
   - `--email` clears BOTH login and registration rows for the address.
   ═══════════════════════════════════════════════════════════════ */

import { db } from "@/lib/db";
import {
  ATTEMPT_RETENTION_MS,
  clearAllAttempts,
  clearAttemptsForEmail,
  pruneLoginAttempts,
} from "@/lib/api/rate-limit";

interface Options {
  mode: "prune" | "email" | "all";
  email?: string;
}

const HELP = `Clear database-backed login-attempt rows.

Usage:
  npm run clear:login-attempts [options]

Options:
  --prune             Delete rows older than the ${Math.round(
    ATTEMPT_RETENTION_MS / 3_600_000
  )}h retention window (default)
  --email <address>   Delete every attempt row for one email (unlock now)
  --all               Delete every attempt row for every account
  -h, --help          Show this help

Examples:
  npm run clear:login-attempts -- --email admin@elitepos.com
  npm run clear:login-attempts -- --all`;

/** Parse argv, or exit with a usage error (code 2). */
function parseArgs(argv: string[]): Options {
  const opts: Options = { mode: "prune" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    }

    if (arg === "--all") {
      opts.mode = "all";
      continue;
    }

    if (arg === "--prune") {
      opts.mode = "prune";
      continue;
    }

    if (arg === "--email" || arg.startsWith("--email=")) {
      const value = arg.startsWith("--email=") ? arg.slice("--email=".length) : argv[++i];
      if (!value || value.startsWith("--")) {
        fail("--email needs an address, e.g. --email admin@elitepos.com");
      }
      opts.mode = "email";
      opts.email = value;
      continue;
    }

    fail(`unknown option: ${arg}`);
  }

  if (opts.mode === "email" && !opts.email) {
    fail("--email needs an address, e.g. --email admin@elitepos.com");
  }

  return opts;
}

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  console.error(HELP);
  process.exit(2);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  let removed = 0;
  if (opts.mode === "all") {
    removed = await clearAllAttempts();
    console.log(`Cleared all login-attempt rows (removed ${removed}).`);
  } else if (opts.mode === "email") {
    removed = await clearAttemptsForEmail(opts.email!);
    console.log(
      `Unlocked ${opts.email} — removed ${removed} attempt row(s). ` +
        "They can sign in again immediately."
    );
  } else {
    removed = await pruneLoginAttempts();
    console.log(`Pruned ${removed} login-attempt row(s) older than the retention window.`);
  }
}

main()
  .catch((err) => {
    console.error("\n❌ Failed to clear login attempts:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
