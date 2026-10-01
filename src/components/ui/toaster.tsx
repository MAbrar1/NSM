"use client";

import * as React from "react";
import { useToastStore, type ToastVariant } from "@/stores/toast-store";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   TOASTER — Electric Embossed Neumorphism
   Renders the global toast stack (top-right, stacked). Mount once in
   the dashboard layout.

   Each card is a compact neumorphic tile: radius-md, 12/16 padding,
   row layout, 10px gap, 18px inline SVG icon in the semantic ink,
   13px/600 title, 12px muted description, 3px accent dot on the
   leading edge. Entrance is opacity + translateY(8px→0); exit is a
   quick opacity fade. Elevation is `.neu-elevated` — never a shadow
   tween.
   ═══════════════════════════════════════════════════════════════ */

const ICON_PATHS: Record<ToastVariant, string> = {
  success: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  error: "M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  warning:
    "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  info: "M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z",
};

const ICON_TONE: Record<ToastVariant, string> = {
  success: "neu-toast-icon-success",
  error: "neu-toast-icon-danger",
  warning: "neu-toast-icon-warning",
  info: "neu-toast-icon-info",
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  // `end-4`, so the stack docks to the shell's trailing edge — the LEFT one in
  // Urdu, where a physical `right-4` put the toasts over the rail. On phones
  // the stack spans the viewport minus margins so long bilingual titles and
  // descriptions wrap instead of pushing the card past the screen edge
  // (inset utilities track RTL the same way end-4 does).
  return (
    <div
      className="fixed top-4 end-4 z-[var(--z-toast)] flex max-w-[calc(100vw-2rem)] flex-col gap-1.5 pointer-events-none sm:max-w-sm"
      aria-live="polite"
      aria-relevant="additions removals"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

interface ToastCardProps {
  toast: { id: string; title: string; description?: string; variant: ToastVariant };
  onDismiss: () => void;
}

function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const [leaving, setLeaving] = React.useState(false);

  React.useEffect(() => {
    if (!leaving) return;
    const wait = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150;
    const timer = setTimeout(onDismiss, wait);
    return () => clearTimeout(timer);
  }, [leaving, onDismiss]);

  function handleDismiss() {
    if (leaving) return;
    setLeaving(true);
  }

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex w-full min-w-0 items-start gap-2.5 rounded-[var(--neu-radius-md)] " +
          "bg-neu-bg p-2.5 neu-elevated shadow-neu-toast " +
          "transition-opacity duration-150 ease-out",
        leaving ? "opacity-0" : "opacity-100"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "shrink-0 rounded-full",
          toast.variant === "success"
            ? "bg-neu-solid-green"
            : toast.variant === "error"
              ? "bg-neu-solid-red"
              : toast.variant === "warning"
                ? "bg-neu-solid-amber"
                : "bg-neu-solid-cyan"
        )}
        style={{ width: 7, height: 7 }}
      />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug break-words text-neu-primary">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 break-words text-xs leading-5 text-neu-muted">{toast.description}</p>
        )}
      </div>

      <button
        type="button"
        onClick={handleDismiss}
        className="neu-focus shrink-0 rounded-md p-1 text-neu-muted transition-colors hover:text-neu-primary"
        aria-label="Dismiss"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
