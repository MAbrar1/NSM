"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  isUnsavedGuardActive,
  bypassUnsavedGuardOnce,
  consumeUnsavedGuardBypass,
} from "@/hooks/use-unsaved-guard";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";

/* ═══════════════════════════════════════════════════════════════
   DIRTY NAV GUARD — mounted ONCE in the dashboard layout.

   Pages declare "I hold unsaved edits" with the one-line hook:

     useUnsavedGuard({ when: dirty });

   …and this component turns that declaration into actual
   protection for both escape routes:

   1. Tab close / reload / external navigation → the native
      `beforeunload` dialog (only while some guard is active).
   2. In-app <Link> navigation (sidebar, breadcrumbs, search
      results) → there is no native dialog, so the click is
      intercepted at the CAPTURE phase — document-level, before
      the router's own listener — and a leave-confirmation dialog
      is shown instead. "Leave" replays the exact clicked target
      via a full assignment; "Stay" closes and the user keeps
      editing.

   Why capture-phase document delegation instead of patching
   router.push: every in-app exit in this app is an <a href>
   rendered by next/link (rail, breadcrumbs, search overlay,
   quick actions), so one listener covers all of them — including
   pages yet to be written — without touching appRouter internals
   that are not a public Next.js API.

   The dirty registry lives in use-unsaved-guard.ts (module scope)
   so the guard needs no context plumbing through the tree.
   ═══════════════════════════════════════════════════════════════ */

export function DirtyNavGuard() {
  const { t } = useI18n();
  const pathname = usePathname();
  const [pendingTarget, setPendingTarget] = React.useState<string | null>(null);
  const pendingRef = React.useRef<string | null>(null);

  // A completed navigation means whatever we were guarding is over.
  React.useEffect(() => {
    pendingRef.current = null;
    setPendingTarget(null);
  }, [pathname]);

  // 1) Tab close / reload / external navigation.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isUnsavedGuardActive()) return;
      e.preventDefault();
      // Chrome ignores the return value but still requires the handler
      // to have run; legacy browsers show returnValue as the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // 2) In-app <Link> navigation — intercepted before the router sees it.
  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!isUnsavedGuardActive()) return;
      // Only plain left clicks; modified clicks open new tabs/windows.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const anchor = (e.composedPath() as EventTarget[]).find(
        (el): el is HTMLAnchorElement => el instanceof Element && el.tagName === "A"
      );
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same path (hash toggle, query-only change) never loses form state.
      if (url.pathname === window.location.pathname) return;
      // Replay of an already-confirmed exit.
      if (consumeUnsavedGuardBypass()) return;
      e.preventDefault();
      e.stopPropagation();
      pendingRef.current = url.pathname + url.search + url.hash;
      setPendingTarget(pendingRef.current);
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  function stay() {
    pendingRef.current = null;
    setPendingTarget(null);
  }

  function leave() {
    const to = pendingRef.current;
    pendingRef.current = null;
    setPendingTarget(null);
    if (to) window.location.assign(to);
  }

  return (
    <Dialog open={pendingTarget !== null} onOpenChange={(o) => !o && stay()}>
      {/* alertdialog: the interaction is destructive (discarding edits). */}
      <DialogContent size="sm" role="alertdialog">
        <DialogHeader>
          <DialogTitle>{t("unsaved.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-neu-muted">{t("unsaved.message")}</p>
        </DialogBody>
        <DialogFooter className="gap-3">
          <Button variant="secondary" className="flex-1" onClick={stay}>
            {t("unsaved.stay")}
          </Button>
          <Button variant="danger" className="flex-1" onClick={leave}>
            {t("unsaved.leave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
