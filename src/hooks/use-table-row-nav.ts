"use client";

import * as React from "react";

/* ═══════════════════════════════════════════════════════════════
   USE TABLE ROW NAV — keyboard navigation for data tables.

   Rows opt in by rendering `data-nav-row` on the <tr>. The hook is
   attached to a container ref (usually the <tbody>) and gives it:

   • Roving tabindex — exactly one row is tabbable; clicking or
     focusing a row moves the roving stop there, so Tab re-enters
     the table where you left it instead of at the first row.
   • ArrowUp/ArrowDown move focus row to row (never scrolling the
     page), Home/End jump to the first/last row, and Enter/Space
     activate the row (the page decides what activate means —
     usually "open detail").
   • Type-ahead: typing printable characters jumps to the first
     row whose `data-nav-label` (or text content) starts with the
     typed string, with a 700ms buffer that resets between words.

   Rows re-scan on DOM mutation inside the container, so sort and
   filter re-renders keep the behaviour — and never steal focus
   mid-navigation. Interactive controls inside a row (buttons,
   checkboxes) remain in the normal tab order and win over the
   roving stop; the row itself is reached with the arrows.

   WCAG 2.1.1 (Keyboard) / ARIA grid-style navigation for the
   app's clickable list tables.
   ═══════════════════════════════════════════════════════════════ */

export function useTableRowNav<T extends HTMLElement = HTMLTableSectionElement>(
  onActivate?: (index: number) => void
) {
  const containerRef = React.useRef<T | null>(null);
  const typeBufRef = React.useRef("");
  const typeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest callback without re-running the wiring effect on
  // every render — the effect attaches listeners once and survives
  // re-renders (re-sorts, refetches) via the MutationObserver.
  const activateRef = React.useRef(onActivate);
  React.useEffect(() => {
    activateRef.current = onActivate;
  });

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const rows = () => Array.from(container.querySelectorAll<HTMLElement>("tr[data-nav-row]"));

    const init = () => {
      const rs = rows();
      rs.forEach((r, i) => {
        r.tabIndex = i === 0 ? 0 : -1;
      });
    };
    init();

    const focusRow = (rs: HTMLElement[], index: number) => {
      const next = rs.length > 0 ? ((index % rs.length) + rs.length) % rs.length : -1;
      if (next < 0) return;
      rs.forEach((r, i) => {
        r.tabIndex = i === next ? 0 : -1;
      });
      rs[next]?.focus();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Never hijack keys meant for a control inside the row.
      if (target.closest("button, input, select, textarea, a[href], [role='switch']") && target !== container) {
        return;
      }
      const rs = rows();
      if (rs.length === 0) return;
      const current = Math.max(0, rs.indexOf(target));

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusRow(rs, current + 1);
          return;
        case "ArrowUp":
          e.preventDefault();
          focusRow(rs, current - 1);
          return;
        case "Home":
          e.preventDefault();
          focusRow(rs, 0);
          return;
        case "End":
          e.preventDefault();
          focusRow(rs, rs.length - 1);
          return;
        case "Enter":
          if (current >= 0 && target === rs[current]) {
            e.preventDefault();
            activateRef.current?.(current);
          }
          return;
        default:
          break;
      }

      // Type-ahead over row labels.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        typeBufRef.current += e.key.toLowerCase();
        if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
        typeTimerRef.current = setTimeout(() => {
          typeBufRef.current = "";
        }, 700);
        const needle = typeBufRef.current;
        const hit = rs.findIndex((r) =>
          (r.getAttribute("data-nav-label") ?? r.textContent ?? "").toLowerCase().startsWith(needle)
        );
        if (hit >= 0) {
          e.preventDefault();
          focusRow(rs, hit);
        }
      }
    };

    // Clicking a row moves the roving stop to it.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof HTMLElement)) return;
      const row = t.closest<HTMLElement>("tr[data-nav-row]");
      if (!row || !container.contains(row)) return;
      const rs = rows();
      const idx = rs.indexOf(row);
      if (idx >= 0) rs.forEach((r, i) => { r.tabIndex = i === idx ? 0 : -1; });
    };

    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("focusin", onFocusIn);

    // Re-scan when the row set changes (sort/filter/pagination).
    const mo = new MutationObserver(() => {
      const rs = rows();
      if (!rs.some((r) => r.tabIndex === 0)) init();
    });
    mo.observe(container, { childList: true, subtree: true });

    return () => {
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("focusin", onFocusIn);
      mo.disconnect();
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return containerRef;
}
