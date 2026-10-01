import { NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api/api-handler";
import { apiError, fieldError, validationError } from "@/lib/api/api-errors";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { registerSchema } from "@/lib/validations";
import {
  checkRegistrationRateLimit,
  clientIp,
  recordRegistrationAttempt,
} from "@/lib/api/rate-limit";

/* ═══════════════════════════════════════════════════════════════
   REGISTER API
   Creates a new user account with hashed password.
   ═══════════════════════════════════════════════════════════════ */

export const POST = withApiHandler("REGISTER_ERROR", async (request) => {
    const ip = clientIp(request.headers);

    // Read the body ONCE — the clone/re-read dance previously risked a
    // second json() throw on malformed payloads and made the throttle check
    // operate on different data than the validation below.
    const body = (await request.json().catch(() => null)) as
      | { email?: string; name?: string; password?: string }
      | null;
    const rawEmail = typeof body?.email === "string" ? body.email : "";

    // Throttle signup spam BEFORE doing any work (per IP + per email).
    if (rawEmail) {
      const limit = await checkRegistrationRateLimit(rawEmail, ip);
      if (limit.limited) {
        const response = NextResponse.json(
          {
            error:
              limit.code === "registration_email_throttled"
                ? "Too many accounts created for this email. Try again later."
                : "Too many registrations from this device. Try again later.",
            code: limit.code,
          },
          { status: 429 }
        );
        if (limit.retryAfterSeconds) {
          response.headers.set("Retry-After", String(limit.retryAfterSeconds));
        }
        return response;
      }
    }

    // Gate public registration: open only when the admin toggle is on,
    // or when this is the first account being created (bootstrap).
    const userCount = await db.user.count({ where: { deletedAt: null } });
    const isBootstrap = userCount === 0;
    if (userCount > 0) {
      const settings = await db.storeSettings.findUnique({
        where: { id: "singleton" },
      });
      if (!(settings?.allowPublicRegistration ?? false)) {
        return apiError("Public registration is disabled. Please contact your administrator.", 403);
      }
    }

    const result = registerSchema.safeParse(body);

    if (!result.success) {
      if (rawEmail) await recordRegistrationAttempt(rawEmail, ip, false);
      return validationError(result.error);
    }

    const { name, email, password } = result.data;

    // Check if user already exists
    const existingUser = await db.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      // Record the failed attempt so probing for existing emails is throttled
      // exactly like any other failed registration.
      await recordRegistrationAttempt(email, ip, false);
      return fieldError({ email: ["An account with this email already exists"] }, 409);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user. The very first account (fresh install) becomes a
    // super_admin so the store owner can manage roles/settings immediately;
    // later public signups always land as cashiers.
    const user = await db.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: isBootstrap ? "super_admin" : "cashier",
      },
    });

    await recordRegistrationAttempt(email, ip, true);

    // Return user without password
    const { password: _, ...userWithoutPassword } = user;

    return NextResponse.json(
      { user: userWithoutPassword, message: "Account created successfully" },
      { status: 201 }
    );
  });
