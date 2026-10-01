"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/providers/i18n-provider";

/* ═══════════════════════════════════════════════════════════════
   DIALOG COMPONENT (v5 — Elite polish pass)

   - Panel elevation: `.neu-dialog-panel` (globals.css) — a levitating
     sheet (soft emboss + one large ambient drop), NOT the flat-tile
     card emboss. This is the single fix for the "dialog looks flat /
     badly shadowed" bug class.
   - Built-in close button: DialogContent renders an X in the corner
     (RTL-aware) unless `hideClose` is set. Every dialog in the app
     gets a visible, named, keyboard-reachable close affordance for
     free — before, only 3 of ~30 dialogs had one.
   - Structure contract (unchanged, keeps the footer-clip fix):
     Content: flex column, max-h clamped to the viewport (dvh so
     mobile URL bars don't clip it), width never exceeds screen.
     Header/Footer: `shrink-0` → they always stay visible.
     Body: `flex-1 min-h-0 overflow-y-auto` → the ONLY scrollable
     region. `min-h-0` is mandatory: without it a flex child refuses
     to shrink below its content height and the clip is lost.
   ═══════════════════════════════════════════════════════════════ */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // scrim + blur live in the .neu-dialog-overlay recipe
      "fixed inset-0 z-50 neu-dialog-overlay",
      "data-[state=open]:animate-fade-in",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    size?: "sm" | "md" | "lg" | "xl";
    /** Hide the built-in X (confirm-destructive rows, print sheets…). */
    hideClose?: boolean;
    /**
     * Vertical ambition of the panel:
     *   • "fit" (default) — hug the content up to the viewport clamp;
     *     confirm sheets, qty editors, short forms.
     *   • "tall" — claim a stable tall frame (~85dvh) so data-heavy
     *     detail views (orders, customers, payment) don't jump height
     *     as tabs/sections stream in; the Body scrolls inside it.
     */
    height?: "fit" | "tall";
  }
>(({
  className,
  children,
  size = "md",
  hideClose = false,
  height = "fit",
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}, ref) => {
  const sizeClasses = {
    sm: "max-w-sm",
    // spec: the default dialog panel is 480px
    md: "max-w-[480px]",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  };

  // Radix hands focus back to `DialogTrigger` on close, and NOT ONE dialog in
  // this codebase renders a trigger: every one is opened from a plain button
  // with a controlled `open` prop. Radix's default path therefore finds no
  // trigger, and focus lands on <body> — the keyboard user loses their place
  // in the page. Remember what was focused as the panel opened and put it
  // back on close, which is what a trigger would have done.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  // The built-in close is a labelled Radix Close, so Esc, ✕ and the footer
  // action all run the same dismiss path. Hidden from the a11y tree when
  // hidden — never a phantom tab stop.
  const { t } = useI18n();

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        // Called before Radix focuses the panel, i.e. while the trigger still
        // holds focus — the only moment the opener is recoverable.
        onOpenAutoFocus={(event) => {
          const active = document.activeElement as HTMLElement | null;
          returnFocusRef.current = active && active !== document.body ? active : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          if (target && document.contains(target) && target.getClientRects().length > 0) {
            // preventDefault also suppresses Radix's own trigger restore via
            // `composeEventHandlers`' defaultPrevented check, so the two can
            // never fight over the same focus.
            event.preventDefault();
            target.focus();
          }
          onCloseAutoFocus?.(event);
        }}
        className={cn(
          "fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]",
          // dvh: on mobile browsers 100vh includes the URL bar area and
          // pushes the footer under it; dvh tracks the visible viewport.
          "w-[calc(100vw-2rem)] sm:w-full p-0",
          sizeClasses[size],
          // surface / radius come from .neu-card; the LEVITATING sheet
          // elevation + entrance come from .neu-dialog-panel (declared
          // after .neu-card, so the shadow handoff is source-order safe).
          "neu-card neu-card-flush neu-dialog-panel",
          "neu-focus",
          "max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col",
          height === "tall" && "h-[85dvh]",
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            aria-label={t("common.close")}
            title={t("common.close")}
            className={cn(
              "neu-dialog-close neu-btn neu-btn-icon-sm neu-focus",
              "bg-neu-bg text-neu-muted hover:text-neu-primary",
              "transition-colors"
            )}
          >
            <svg
              className="h-4 w-4"
              aria-hidden
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "shrink-0 flex items-start justify-between gap-3 p-6 pb-4",
        // the header rule is the dark edge of the separator emboss
        "border-b border-[color:var(--neu-shadow-dark)]",
        // the built-in close keycap sits 12px inside the trailing corner —
        // reserve that corner so long titles never slide under it (the X is
        // a physical position on the panel, not a logical child of the row).
        "pe-16",
        className
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("neu-dialog-title", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("neu-dialog-text mt-1", className)} {...props} />;
}

function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // min-h-0 is the load-bearing class: a flex child with overflow-y
        // must be allowed to shrink or the scroll container never scrolls.
        "flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-4 pos-scroll",
        className
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // the footer rule is the dark edge of the separator emboss; the
        // faint recessed tint grounds the actions without a hard fill
        "shrink-0 flex items-center justify-end gap-2 px-6 py-4",
        "border-t border-[color:var(--neu-shadow-dark)] bg-neu-sunken/40",
        // keep the buttons clear of the rounded panel corners
        "rounded-b-[inherit]",
        // Mobile: a row of long bilingual labels ("واجبات ادا کریں" /
        // "Record payment") either truncates or forces a horizontal
        // squeeze. Stack full-width below sm, row back at sm+.
        "max-sm:sticky max-sm:bottom-0 max-sm:flex-col-reverse max-sm:items-stretch max-sm:gap-2",
        "[&>*]:max-sm:w-full",
        // A sticky footer paints over body content while scrolling —
        // keep it above the Body but BELOW the panel's close keycap
        // (which the recipe parks at z-index 10) so ✕ never hides.
        "relative z-[5]",
        className
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogOverlay,
  DialogPortal,
  DialogClose,
};
