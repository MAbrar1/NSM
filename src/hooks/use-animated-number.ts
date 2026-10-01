"use client";

import * as React from "react";

/* ═══════════════════════════════════════════════════════════════
   USE ANIMATED NUMBER — the KPI ticker engine.

   StatCard values refresh every 60s; a raw swap makes the number
   snap, which reads as "did it change?". This hook eases the visible
   number toward its target over ~600ms with an ease-out curve, so a
   jump from 1,240 → 1,780 is legible as *movement*.

   Design notes:
   • prefers-reduced-motion: honor it — snap straight to the target,
     no rAF loop is ever started.
   • First render returns the target AS-IS: a ticker that plays "0 →
     1,240" on every page mount is a gimmick; the animation exists
     only for value CHANGES the user is watching.
   • requestAnimationFrame loop cleans itself up on unmount and on
     target change; no trailing timers.
   • Non-finite / NaN targets degrade to a static value.
   ═══════════════════════════════════════════════════════════════ */

const TICK_MS = 600;

export function useAnimatedNumber(target: number, enabled: boolean): number {
  const [display, setDisplay] = React.useState(target);
  const fromRef = React.useRef(target);
  const rafRef = React.useRef<number | null>(null);

  // Mirror for the cleanup below (avoid re-running the effect on it):
  // an interrupted tween freezes where it was, and the next run eases
  // from there instead of snapping back to an older value.
  const displayRef = React.useRef(display);
  React.useEffect(() => {
    displayRef.current = display;
  }, [display]);

  React.useEffect(() => {
    // Cases that snap instead of animate:
    if (!enabled || !Number.isFinite(target)) {
      setDisplay(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;

    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(target);
      fromRef.current = target;
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TICK_MS);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (target - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Freeze wherever the tween was interrupted; the next run eases
      // from here instead of snapping back.
      fromRef.current = displayRef.current;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, enabled]);

  return display;
}
