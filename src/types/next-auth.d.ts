import type { Role } from "@/lib/rbac";

/* ═══════════════════════════════════════════════════════════════
   NEXTAUTH TYPE EXTENSIONS
   Adds role and id to the session user and JWT token.
   ═══════════════════════════════════════════════════════════════ */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: Role;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role: Role;
    id: string;
  }
}
