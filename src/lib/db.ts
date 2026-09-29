import { PrismaClient } from "@prisma/client";

/* ═══════════════════════════════════════════════════════════════
   PRISMA CLIENT SINGLETON
   Prevents multiple Prisma Client instances in development
   due to hot-reloading. Use this everywhere instead of new PrismaClient().
   ═══════════════════════════════════════════════════════════════ */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
