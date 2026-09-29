"use client";

import * as React from "react";

/* ═══════════════════════════════════════════════════════════════
   POPOVER MENU CONTRACT
   The keyboard behaviour of an ANCHORED popover — the currency and
   theme pickers, the export menu, the header's account and
   notification menus.

   It is deliberately NOT the modal contract (`useModalFocus`): a
   popover must not trap. What it owes is:

   • open  — focus moves to the checked item (or the first), so a
             keyboard user lands inside the panel they just opened
             instead of scrolling the page under it.
   • ↑ / ↓ — move through the items and wrap, Home / End to the ends.
   • Esc   — close AND hand focus back to the trigger. This is the
             part that was missing everywhere: closing left focus on
             `<body>`, i.e. the user's place was gone.
   • Tab   — close and continue from the trigger, so the next Tab
             moves to the NEXT control in the page, not one inside a
             panel that is about to disappear.

   Every caller supplies the two refs it already has. The roles
   (`menu` + `menuitemradio`, `listbox` + `option`) stay with the
   caller: the hook navigates whatever items the panel declares.
   ═══════════════════════════════════════════════════════════════ */

const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';

export function usePopoverMenu({
  open,
  triggerRef,
  panelRef,
  onClose,
}: {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  panelRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  // Latest onClose without re-subscribing the whole effect on every render.
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const items = () => Array.from(panel.querySelectorAll<HTMLElement>(ITEM));

    // Land inside the panel, on the current value when there is one. A
    // single-choice menu marks it with `aria-checked`, a listbox with
    // `aria-selected`; whichever the caller declared.
    const target =
      items().find(
        (el) => el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true"
      ) ?? items()[0];
    target?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "Tab") {
        // Close, hand focus back, and let the browser continue from there.
        closeRef.current();
        triggerRef.current?.focus();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (e.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % list.length;
      else if (e.key === "ArrowUp") next = index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      if (next < 0) return;
      e.preventDefault();
      list[next]?.focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, panelRef, triggerRef]);
}
