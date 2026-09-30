import { auth } from "@/lib/middleware-auth";
import { NextResponse } from "next/server";

/* ═══════════════════════════════════════════════════════════════
   ROUTE PROTECTION MIDDLEWARE
   Protects all dashboard routes. Unauthenticated users
   are redirected to /login. Public routes are excluded.
   Includes CSRF protection for state-changing API methods.
   ═══════════════════════════════════════════════════════════════ */

const publicRoutes = ["/login", "/register", "/api/auth", "/api/health"];
const apiAuthRoutes = ["/api/auth"];

// CSRF-protected methods (state-changing operations)
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Origins that are always trusted (same-app requests)
const SAFE_METHODS_FOR_CSRF = new Set(["GET", "HEAD", "OPTIONS"]);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // Allow auth API routes (NextAuth needs these)
  if (apiAuthRoutes.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // CSRF protection for state-changing API mutations.
  // Checks that POST/PUT/PATCH/DELETE to /api/* routes come from:
  //   1. Same-origin requests (standard browser form submissions)
  //   2. Requests with a valid Referer header from the same host
  //   3. Requests with a custom x-csrf-token header (for fetch/AJAX)
  if (
    pathname.startsWith("/api/") &&
    STATE_CHANGING_METHODS.has(method) &&
    !SAFE_METHODS_FOR_CSRF.has(method)
  ) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    const host = req.headers.get("host");
    const csrfHeader = req.headers.get("x-csrf-token");
    const xRequestedWith = req.headers.get("x-requested-with");

    // Cron endpoints authenticate with a shared secret, so they cannot
    // carry a session CSRF token. Exempt them when the secret header
    // matches — the route handler itself re-checks the secret.
    const cronSecret = process.env["CRON_SECRET"];
    const cronAuthed =
      cronSecret &&
      (req.headers.get("authorization") === `Bearer ${cronSecret}` ||
        req.headers.get("x-cron-secret") === cronSecret);
    if (
      cronAuthed &&
      (pathname === "/api/notifications/low-stock/run" ||
        pathname === "/api/inventory/reserve/cleanup" ||
        pathname === "/api/maintenance/run")
    ) {
      return NextResponse.next();
    }

    // Allow if: same origin, or has CSRF token, or is XMLHttpRequest from same host.
    // new URL() throws on malformed headers — treat those as NOT same-origin
    // (fail closed) instead of letting the exception bubble into a 500.
    const isSameOrigin =
      (origin && host && safeUrlHost(origin) === host) ||
      (referer && host && safeUrlHost(referer) === host);

    const hasCsrfToken = Boolean(csrfHeader);
    const isFetchFromSameHost =
      xRequestedWith === "XMLHttpRequest" && isSameOrigin;

    if (!isSameOrigin && !hasCsrfToken && !isFetchFromSameHost) {
      return NextResponse.json(
        { error: "CSRF validation failed. Include a valid Origin or Referer header." },
        { status: 403 }
      );
    }
  }

  // Allow public routes
  if (publicRoutes.some((route) => pathname.startsWith(route))) {
    // If already logged in and visiting login/register, redirect to dashboard
    if (req.auth && (pathname === "/login" || pathname === "/register")) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  // Protect all other routes. API consumers expect a JSON 401, not an HTML
  // redirect to the login page (a fetch() would follow the redirect and get
  // the login markup instead of an error it can render).
  if (!req.auth) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Match all routes except static files, images AND bundled fonts.
    // Fonts must be auth-free: the receipt/report print windows and the
    // rasterizer fetch /fonts/*.woff2 as static assets — routing them
    // through the auth gate 307'd them to /login and Urdu silently
    // fell back to system fonts on paper (found by the offline-serve
    // verification of the typography correction).
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?|ttf|otf)$).*)",
  ],
};

/** Extract a URL's host, or null when the header is malformed. */
function safeUrlHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
