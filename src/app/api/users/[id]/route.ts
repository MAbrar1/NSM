import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError } from "@/lib/api-errors";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import type { Role } from "@/lib/rbac";
import { requirePermission, canGrantRole } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";

/* ═══════════════════════════════════════════════════════════════
   SINGLE USER API
   PUT    /api/users/:id — Update user
   DELETE /api/users/:id — Soft-delete user
   ═══════════════════════════════════════════════════════════════ */

const VALID_ROLES: Role[] = ["super_admin", "admin", "manager", "cashier", "inventory_clerk", "viewer"];

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user: actor, response } = await requirePermission("users:edit");
    if (response) return response;

    const { id } = await params;
    const body = await request.json();
    const { name, email, password, role, isActive } = body;

    const existing = await db.user.findUnique({ where: { id } });
    if (!existing) {
      return apiError("User not found", 404);
    }

    if (role && !VALID_ROLES.includes(role)) {
      return fieldError({ role: ["Invalid role"] }, 400);
    }

    // Role-escalation guard: only a super_admin may modify a super_admin
    // account, assign the super_admin role, or deactivate one.
    const touchingSuperAdmin =
      existing.role === "super_admin" || (role && role === "super_admin");
    if (touchingSuperAdmin && actor.role !== "super_admin") {
      return apiError("Only a super admin can modify super admin accounts", 403);
    }
    if (role && !canGrantRole(actor.role, role as Role)) {
      return apiError("Only a super admin can assign the super admin role", 403);
    }

    // Prevent deactivating your own account — a user must not be able to
    // lock themselves (and everyone else who depends on their session) out.
    if (actor.id === id && isActive === false) {
      return apiError("You cannot deactivate your own account", 400);
    }

    // Self-service guard: an admin editing their OWN account must not be
    // able to silently grant themselves a higher role.
    if (actor.id === id && role && role !== existing.role) {
      return apiError("You cannot change your own role", 400);
    }

    // Check email uniqueness
    if (email && email !== existing.email) {
      const dup = await db.user.findUnique({ where: { email } });
      if (dup) {
        return fieldError({ email: ["Email already in use"] }, 409);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = {};
    if (name) updateData["name"] = name;
    if (email) updateData["email"] = email;
    if (role) updateData["role"] = role;
    if (isActive !== undefined) updateData["isActive"] = isActive;
    if (password) {
      // Keep API-created passwords at least as strong as public signups
      // (see registerSchema in lib/validations).
      if (
        typeof password !== "string" ||
        password.length < 8 ||
        !/[A-Z]/.test(password) ||
        !/[a-z]/.test(password) ||
        !/[0-9]/.test(password)
      ) {
        return fieldError({ password: ["Password must be at least 8 characters and contain uppercase, lowercase, and a number"] }, 400);
      }
      updateData["password"] = await bcrypt.hash(password, 12);
    }

    const user = await db.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    logAudit({
      userId: actor.id,
      action: "update",
      entity: "user",
      entityId: user.id,
      entityName: user.email,
      newValues: { name: user.name, role: user.role, isActive: user.isActive },
    });

    return NextResponse.json({ user });
  } catch (error) {
    console.error("PUT /api/users/[id] error:", error);
    return apiError("Failed to update user", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requirePermission("users:delete");
    if (authResult.response) return authResult.response;

    const { id } = await params;
    const existing = await db.user.findUnique({ where: { id } });
    if (!existing) {
      return apiError("User not found", 404);
    }

    // Prevent deleting super_admin
    if (existing.role === "super_admin") {
      return apiError("Cannot delete super admin", 403);
    }

    // Prevent self-deletion
    if (authResult.user.id === id) {
      return apiError("Cannot delete your own account", 400);
    }

    await db.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    logAudit({
      userId: authResult.user.id,
      action: "delete",
      entity: "user",
      entityId: existing.id,
      entityName: existing.email,
      oldValues: { name: existing.name, email: existing.email, role: existing.role },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/users/[id] error:", error);
    return apiError("Failed to delete user", 500);
  }
}
