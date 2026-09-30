import { NextRequest, NextResponse } from "next/server";
import { apiError, fieldError } from "@/lib/api-errors";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import type { Role } from "@/lib/auth/rbac";
import { requirePermission, canGrantRole } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";
import { parsePagination } from "@/lib/pagination";
import { parseSortParam } from "@/lib/table-sort";

/* ═══════════════════════════════════════════════════════════════
   USERS MANAGEMENT API
   GET  /api/users — List with search, role filter
   POST /api/users — Create new user (admin only)
   ═══════════════════════════════════════════════════════════════ */

const VALID_ROLES: Role[] = ["super_admin", "admin", "manager", "cashier", "inventory_clerk", "viewer"];

export async function GET(request: NextRequest) {
  try {
    // User listing is sensitive — gate it with the users:view permission
    const { response } = await requirePermission("users:view");
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const role = searchParams.get("role") || "";
    const { page, pageSize: limit, skip, take } = parsePagination(searchParams, {
      defaultPageSize: 20,
      pageSizeParam: "limit",
    });

    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (role) where.role = role;
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { email: { contains: search } },
      ];
    }

    // Allow-listed sort — a hand-edited query falls back to createdAt.desc
    // instead of reaching Prisma's orderBy and throwing. Status sorts on
    // the Boolean column, so inactive rows cluster after active ones.
    const sort = parseSortParam(
      searchParams.get("sort"),
      ["name", "email", "role", "isActive", "lastLoginAt", "createdAt"],
      { field: "createdAt", order: "desc" }
    );
    const orderBy: Prisma.UserOrderByWithRelationInput = { [sort.field]: sort.order };

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          avatarUrl: true,
          lastLoginAt: true,
          createdAt: true,
        },
        orderBy,
        skip,
        take,
      }),
      db.user.count({ where }),
    ]);

    return NextResponse.json({
      users,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("GET /api/users error:", error);
    return apiError("Failed to fetch users", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user: actor, response } = await requirePermission("users:create");
    if (response) return response;

    const body = await request.json();
    const { name, email, password, role } = body;

    // Field-keyed so the form can underline the exact input rather than
    // toast a joint "name, email and password are required" with no target.
    const missing: Record<string, string[]> = {};
    if (!name) missing["name"] = ["Name is required"];
    if (!email) missing["email"] = ["Email is required"];
    if (!password) missing["password"] = ["Password is required"];
    if (Object.keys(missing).length > 0) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    // Same password policy as public signups (registerSchema) so admin-
    // created accounts can never be weaker than self-registered ones.
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return fieldError({ password: ["Password must be at least 8 characters and contain uppercase, lowercase, and a number"] }, 400);
    }

    if (role && !VALID_ROLES.includes(role)) {
      return fieldError({ role: ["Invalid role"] }, 400);
    }

    // Only super_admins may create super_admin accounts (prevents an admin
    // from silently escalating their own privileges)
    const targetRole = (role as Role | undefined) ?? "cashier";
    if (!canGrantRole(actor.role, targetRole)) {
      return apiError("Only a super admin can create a super admin account", 403);
    }

    // Check duplicate email
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return fieldError({ email: ["Email already in use"] }, 409);
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await db.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: targetRole,
      },
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
      action: "create",
      entity: "user",
      entityId: user.id,
      entityName: user.email,
      newValues: { name: user.name, email: user.email, role: user.role },
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    console.error("POST /api/users error:", error);
    return apiError("Failed to create user", 500);
  }
}
