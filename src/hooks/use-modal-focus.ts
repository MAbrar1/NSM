"use client";

import * as React from "react";

/* ═══════════════════════════════════════════════════════════════
   MODAL FOCUS CONTRACT
   The behaviour Radix gives every <Dialog>: focus moves INTO the
   panel when it opens, Tab cannot walk out of it while it is open,
   and focus goes BACK to whatever opened it on close.

   The overlays in this app that are hand-rolled rather than built on
   <Dialog> — the mobile nav drawer, the ⌘K command palette, the
   keyboard-shortcuts modal and the image lightbox — all announced
   themselves as `role="dialog" aria-modal="true"` while implementing
   none of it. Telling assistive tech the rest of the page is inert
   *while the focus ring walks straight behind the scrim* is worse
   than not announcing a modal at all, so they all go through here.

   Radix's own restore cannot be reused: it focuses `DialogTrigger`,
   and no dialog in this codebase renders one (every one is opened
   from a plain button with a controlled `open` prop), so focus fell
   to <body> and the keyboard user lost their place.
   ═══════════════════════════════════════════════════════════════ */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param open     whether the panel is currently shown
 * @param panelRef the panel that owns the trap (the element carrying
 *                 `role="dialog"`, so the trap and the announcement
 *                 can never drift apart)
 */
export function useModalFocus(open: boolean, panelRef: React.RefObject<HTMLElement | null>) {
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  // The opener is captured in a LAYOUT effect, not a passive one, because a
  // passive effect here is already too late: sibling effects that focus the
  // panel's own field (`if (open) inputRef.current?.focus()`) are declared
  // after this hook and would still run first on some panels, leaving the
  // opener recorded as "something inside the panel" and dropping the focus
  // handoff on close. Layout effects run before every passive effect in the
  // commit, while the click that opened the panel is still the last thing to
  // have held focus.
  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const active = document.activeElement as HTMLElement | null;
    returnFocusRef.current =
      active && active !== document.body && !(panel && panel.contains(active)) ? active : null;
  }, [open, panelRef]);

  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const items = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Move focus in — unless something already claimed it inside (a panel
    // that focuses its own search field should keep it).
    if (!panel.contains(document.activeElement)) {
      const first = items()[0];
      // A panel with no focusable content yet (async loading) gets no initial
      // focus: focus() would be a no-op and Tab would start over anyway.
      if (first) first.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = items();
      if (list.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      // Focus escaping the panel at all counts as "walking out", not just
      // landing on the last item.
      const outside = !active || !panel.contains(active);
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase: the trap has to see Tab before any other handler can
    // swallow it, and before the browser's own default action moves focus.
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // By now the panel is usually already gone from the DOM (it renders
      // conditionally), so the opener is the only thing worth reaching for.
      // Skip it if it went away with the panel, or is hidden at the current
      // breakpoint — focusing a hidden element silently does nothing and
      // reads as a dropped handoff.
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back && document.contains(back) && back.getClientRects().length > 0) back.focus();
    };
  }, [open, panelRef]);
}
