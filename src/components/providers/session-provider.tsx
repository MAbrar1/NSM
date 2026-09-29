"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";

/* ═══════════════════════════════════════════════════════════════
   SESSION PROVIDER
   Wraps the app with NextAuth session context.
   Must be a client component.
   ═══════════════════════════════════════════════════════════════ */

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return <NextAuthSessionProvider>{children}</NextAuthSessionProvider>;
}
