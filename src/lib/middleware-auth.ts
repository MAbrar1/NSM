import NextAuth from "next-auth";

/* ═══════════════════════════════════════════════════════════════
   EDGE-SAFE NEXTAUTH INSTANCE (for middleware only)
   The middleware runs on the Edge runtime, where the Prisma client
   cannot be bundled. Session verification for JWT sessions only needs
   the shared secret — no database and no providers — so this config
   mirrors the token shape from src/lib/auth.ts (role/id) without
   importing Prisma. Route handlers keep using the full config.
   ═══════════════════════════════════════════════════════════════ */

export const { auth } = NextAuth({
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    async jwt({ token }) {
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user["role"] = token["role"] as import("@/lib/rbac").Role;
        session.user["id"] = token["id"] as string;
      }
      return session;
    },
  },
});
