import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neu-sunken">
      <div className="space-y-6 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-neu-sunken">
          <span className="text-4xl font-bold text-neu-faint">404</span>
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neu-primary">Page Not Found</h1>
          <p className="mt-2 text-neu-faint">
            The page you are looking for does not exist or has been moved.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-neu-accent-solid border border-neu-accent-line px-4 text-sm font-medium text-white shadow-sm transition-all hover:bg-neu-accent-solid-strong active:scale-[0.98] neu-focus"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
