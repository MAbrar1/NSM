/* ═══════════════════════════════════════════════════════════════
   USE UNSAVED GUARD — one hook for "dirty form" protection.

   Split responsibilities:

   • THIS hook (per page): registers whether the page currently
     holds unsaved edits. That's all a page should have to do:

       useUnsavedGuard({ when: dirty });

     The registration lives in a module-level counter so the guard
     does not need to thread context through the component tree,
     and it is cleaned up automatically on unmount (so navigating
     away from the page — after discarding, or after a save —
     never leaves a stale lock behind).

   • DirtyNavGuard (src/components/layout/dirty-nav-guard.tsx,
     mounted once in the dashboard layout): reads that registry and
     actually blocks the two escape routes — the native
     beforeunload dialog for tab close/reload, and a leave
     confirmation for in-app <Link> navigation (sidebar,
     breadcrumbs, search results). The user can either stay and
     keep editing, or confirm and continue to the clicked target.

   Callers that intentionally clear the dirty flag right after a
   successful save don't need an escape hatch: they simply stop
   passing `when: true`, which unregisters the lock on the same
   render.
   ═══════════════════════════════════════════════════════════════ */

import * as React from "react";

/* Number of mounted pages currently reporting unsaved edits. */
let activeGuards = 0;

/* One-shot bypass, armed by the leave dialog itself so the replayed
 * navigation (which happens while the page is still dirty) doesn't
 * get intercepted a second time. */
let bypassOnce = false;

export function isUnsavedGuardActive(): boolean {
  return activeGuards > 0;
}

/** Arm a single navigation bypass (used by DirtyNavGuard's Leave action). */
export function bypassUnsavedGuardOnce(): void {
  bypassOnce = true;
}

export function consumeUnsavedGuardBypass(): boolean {
  const armed = bypassOnce;
  bypassOnce = false;
  return armed;
}

interface GuardOptions {
  /** True while the page holds unsaved edits worth protecting. */
  when: boolean;
}

export function useUnsavedGuard({ when }: GuardOptions): void {
  React.useEffect(() => {
    if (!when) return;
    activeGuards += 1;
    return () => {
      activeGuards -= 1;
    };
  }, [when]);
}
