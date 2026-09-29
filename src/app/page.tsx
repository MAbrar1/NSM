import Link from "next/link";

/* ═══════════════════════════════════════════════════════════════
   ROOT PAGE
   Landing page with app branding and navigation to main areas.
   ═══════════════════════════════════════════════════════════════ */

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neu-sunken">
      <div className="mx-auto max-w-lg space-y-8 px-6 text-center">
        {/* Logo / Brand */}
        <div className="space-y-3">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-neu-accent-solid text-white shadow-lg shadow-neu-accent-line/30">
            <svg
              className="h-8 w-8"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
              />
            </svg>
          </div>
          <h1 className="heading-1 text-neu-primary">ElitePOS</h1>
          <p className="text-neu-faint body-large">
            Professional Inventory &amp; Point of Sale Management System
          </p>
        </div>

        {/* Navigation Cards */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/dashboard"
            className="group rounded-xl border border-neu-hairline bg-neu-bg p-6 shadow-sm transition-all duration-200 hover:border-neu-accent-line hover:shadow-md hover:shadow-neu-accent-line/10"
          >
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-neu-accent-wash text-neu-accent-ink transition-colors group-hover:bg-neu-accent-wash">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
                />
              </svg>
            </div>
            <h3 className="font-semibold text-neu-primary">Dashboard</h3>
            <p className="mt-1 text-sm text-neu-faint">
              Overview &amp; analytics
            </p>
          </Link>

          <Link
            href="/pos"
            className="group rounded-xl border border-neu-hairline bg-neu-bg p-6 shadow-sm transition-all duration-200 hover:border-neu-accent-line hover:shadow-md hover:shadow-neu-accent-line/10"
          >
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-neu-wash-green text-neu-ink-green transition-colors group-hover:bg-neu-wash-green">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h3 className="font-semibold text-neu-primary">Point of Sale</h3>
            <p className="mt-1 text-sm text-neu-faint">
              Process transactions
            </p>
          </Link>

          <Link
            href="/products"
            className="group rounded-xl border border-neu-hairline bg-neu-bg p-6 shadow-sm transition-all duration-200 hover:border-neu-accent-line hover:shadow-md hover:shadow-neu-accent-line/10"
          >
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-neu-wash-amber text-neu-ink-amber transition-colors group-hover:bg-neu-wash-amber">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
            <h3 className="font-semibold text-neu-primary">Products</h3>
            <p className="mt-1 text-sm text-neu-faint">
              Manage inventory catalog
            </p>
          </Link>

          <Link
            href="/inventory"
            className="group rounded-xl border border-neu-hairline bg-neu-bg p-6 shadow-sm transition-all duration-200 hover:border-neu-accent-line hover:shadow-md hover:shadow-neu-accent-line/10"
          >
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-neu-wash-cyan text-neu-ink-cyan transition-colors group-hover:bg-neu-wash-cyan">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                />
              </svg>
            </div>
            <h3 className="font-semibold text-neu-primary">Inventory</h3>
            <p className="mt-1 text-sm text-neu-faint">
              Stock &amp; warehouse mgmt
            </p>
          </Link>
        </div>

        {/* Footer */}
        <p className="text-xs text-neu-faint">
          ElitePOS v0.1.0 &middot; Built for performance &amp; reliability
        </p>
      </div>
    </main>
  );
}
