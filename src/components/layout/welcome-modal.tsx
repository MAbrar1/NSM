"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/providers/i18n-provider";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/* ═══════════════════════════════════════════════════════════════
   WELCOME / ONBOARDING MODAL
   Shown once (first visit) per browser — a localStorage flag keyed
   by version so a meaningful update can re-introduce itself. Lists
   the fastest paths into the app's core loops plus keyboard
   shortcuts, and never blocks: dismissible by Esc, ✕, or "Get
   started".
   ═══════════════════════════════════════════════════════════════ */

const WELCOME_SEEN_KEY = "pos_welcome_seen_v1";

const QUICK_LINKS = [
  {
    href: "/pos",
    iconPath: "M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z",
    titleKey: "welcome.posTitle",
    descKey: "welcome.posDesc",
  },
  {
    href: "/products",
    iconPath: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    titleKey: "welcome.productsTitle",
    descKey: "welcome.productsDesc",
  },
  {
    href: "/inventory",
    iconPath: "M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m-3.75-6.75h7.5",
    titleKey: "welcome.inventoryTitle",
    descKey: "welcome.inventoryDesc",
  },
  {
    href: "/reports",
    iconPath: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
    titleKey: "welcome.reportsTitle",
    descKey: "welcome.reportsDesc",
  },
] as const;

const SHORTCUTS = [
  { keys: "Ctrl + K", descKey: "welcome.shortcutSearch" },
  { keys: "Ctrl + ↵", descKey: "welcome.shortcutCheckout" },
  { keys: "↑ ↓ ↵", descKey: "welcome.shortcutNav" },
  { keys: "F2", descKey: "welcome.shortcutScanner" },
] as const;

export function WelcomeModal() {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      if (!localStorage.getItem(WELCOME_SEEN_KEY)) setOpen(true);
    } catch {
      // Storage unavailable (private mode) — stay quiet, don't nag.
    }
  }, []);

  function dismiss() {
    setOpen(false);
    try {
      localStorage.setItem(WELCOME_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  function go(href: string) {
    dismiss();
    router.push(href);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent size="md">
        <DialogHeader>
          {/* urdu-display: in Urdu the welcome headline sets in Nastaliq —
              the one sanctioned on-screen Nastaliq role (large, decorative). */}
          <DialogTitle className="urdu-display">{t("welcome.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-neu-faint">{t("welcome.subtitle")}</p>

          {/* Quick links */}
          <div className="grid grid-cols-2 gap-2">
            {QUICK_LINKS.map((l) => (
              <button
                key={l.href}
                type="button"
                onClick={() => go(l.href)}
                className="group flex items-start gap-3 rounded-xl border border-neu-hairline p-3 text-start transition-colors hover:border-neu-accent-line hover:bg-neu-accent-wash/60"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neu-accent-wash text-neu-accent-ink-strong transition-colors group-hover:bg-neu-accent-solid">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d={l.iconPath} />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-neu-primary">{t(l.titleKey)}</p>
                  <p className="mt-0.5 text-xs text-neu-faint">{t(l.descKey)}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Shortcuts */}
          <div className="rounded-xl bg-neu-sunken p-3">
            <p className="mb-2 text-xs font-semibold text-neu-muted">
              {t("welcome.shortcutsTitle")}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {SHORTCUTS.map((s) => (
                <span key={s.keys} className="flex items-center gap-1.5 text-xs text-neu-faint">
                  <kbd className="rounded-md border border-neu-hairline bg-neu-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neu-primary shadow-sm">
                    {s.keys}
                  </kbd>
                  {t(s.descKey)}
                </span>
              ))}
            </div>
          </div>
        </DialogBody>
        <DialogFooter className="dark:bg-neu-sunken/40">
          <Button onClick={dismiss}>{t("welcome.getStarted")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
