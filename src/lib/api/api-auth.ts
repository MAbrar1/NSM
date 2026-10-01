import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { hasPermission, type Role, type Permission } from "@/lib/auth/rbac";

/* ═══════════════════════════════════════════════════════════════
   API AUTH HELPER
   Centralizes session resolution + RBAC enforcement for API routes.

   Usage:
     const authResult = await requirePermission("products:create");
     if (authResult.response) return authResult.response; // 401/403
     const user = authResult.user;
   ═══════════════════════════════════════════════════════════════ */

export interface AuthUser {
  id: string;
  name?: string | null;
  email?: string | null;
  role: Role;
}

export async function requirePermission(
  permission?: Permission
): Promise<{ user: AuthUser; response: null } | { user: null; response: NextResponse }> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      user: null,
      response: NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    };
  }

  const user: AuthUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
  };

  if (permission && !hasPermission(user.role, permission)) {
    return {
      user: null,
      response: NextResponse.json(
        { error: `You do not have permission to perform this action` },
        { status: 403 }
      ),
    };
  }

  return { user, response: null };
}

/**
 * Whether `actorRole` is allowed to grant or manage `targetRole`.
 * Only super_admins may create/modify super_admin accounts — this
 * prevents an admin (or anyone with users:edit) from silently
 * escalating privileges.
 */
export function canGrantRole(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === "super_admin") return actorRole === "super_admin";
  return true;
}