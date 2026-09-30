import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIp,
  recordLoginAttempt,
  type LoginRateLimitCode,
} from "@/lib/rate-limit";

/* ═══════════════════════════════════════════════════════════════
   NEXTAUTH CONFIGURATION (v5)
   Credentials provider (JWT sessions).

   IMPORTANT: `db` is NOT imported statically here. This module is also
   loaded by src/middleware.ts, which bundles for the Edge runtime where
   the Prisma client cannot run. The database is only needed inside the
   credentials `authorize()` callback — which only ever runs in the Node
   runtime on a real sign-in — so it is lazy-loaded there.
   ═══════════════════════════════════════════════════════════════ */

export const {
  handlers,
  signIn,
  signOut,
  auth,
} = NextAuth({
  // Trust the request's Host header so callbacks/redirects follow the
  // address the browser actually used (e.g. a dev server that landed on a
  // different port than AUTH_URL). Without this, Auth.js only trusts an
  // explicitly configured URL and any mismatch makes it bail out.
  trustHost: true,
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // Lazy-load Prisma only when a real sign-in happens (Node runtime) —
        // keeps the Edge middleware bundle free of the Prisma client.
        const { db } = await import("@/lib/db");
        const ip = clientIp(request?.headers ?? new Headers());

        // Enforce the lockout/throttle policy BEFORE checking credentials so
        // repeated failures can't hammer the bcrypt comparison.
        const limit = await checkLoginRateLimit(
          credentials.email as string,
          ip
        );
        if (limit.limited) {
          // Surfaces as `?error=CredentialsSignin&code=<code>` — the login page
          // maps the code to a localized message, telling an account lockout
          // apart from a device/IP throttle.
          throw new RateLimitedError(
            limit.code === "ip_throttled" ? "ip_throttled" : "email_locked"
          );
        }

        // Lookup is case-insensitive (the rate limiter keys failures on a
        // lower-cased email, but the account rows may keep legacy casing —
        // a capitalized typed email used to miss and count as a failure).
        // SQLite has no `mode: "insensitive"`, so match on the lower-cased
        // form; exact-match rows are found by the same predicate.
        const typedEmail = credentials.email as string;
        const user = await db.user.findFirst({
          where: { email: { equals: typedEmail.toLowerCase() } },
        });

        if (!user || !user.isActive) {
          await recordLoginAttempt(typedEmail, ip, false);
          return null;
        }

        const isPasswordValid = await bcrypt.compare(
          credentials.password as string,
          user.password
        );

        if (!isPasswordValid) {
          await recordLoginAttempt(credentials.email as string, ip, false);
          return null;
        }

        // Successful login — clear this email's failure history (keyed on
        // the canonical account email), then update the last login time
        // (failures are cleared first so the successful attempt itself is
        // not mistaken for a new failure).
        await clearLoginFailures(user.email);
        await db.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role as import("@/lib/auth/rbac").Role,
        } as typeof user & { role: import("@/lib/auth/rbac").Role };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token["role"] = (user as Record<string, unknown>)["role"] as import("@/lib/auth/rbac").Role;
        token["id"] = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user["role"] = token["role"] as import("@/lib/auth/rbac").Role;
        session.user["id"] = token["id"] as string;
      }
      return session;
    },
  },
});

/**
 * Thrown when the login rate-limit/lockout policy blocks an attempt.
 * Subclassing CredentialsSignin lets the failure surface on the login
 * page as `?error=CredentialsSignin&code=<code>`, where the client maps
 * the code to a localized message.
 *
 * The code distinguishes the two policies:
 * - `rate_limited`    — too many failures for this email (account lockout)
 * - `rate_limited_ip` — too many attempts from this device/IP
 */
class RateLimitedError extends CredentialsSignin {
  constructor(reason: LoginRateLimitCode) {
    super();
    this.code = reason === "ip_throttled" ? "rate_limited_ip" : "rate_limited";
  }
}
