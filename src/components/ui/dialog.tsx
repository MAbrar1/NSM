"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   DIALOG COMPONENT (v4)
   Fix for the "footer cut off / body unscrollable" bug class
   found in the POS payment modal:

   - Content: flex column, max-h clamped to the viewport (dvh so
     mobile URL bars don't clip it), width never exceeds screen.
   - Header/Footer: `shrink-0` → they always stay visible.
   - Body: `flex-1 min-h-0 overflow-y-auto` → the ONLY scrollable
     region. `min-h-0` is mandatory: without it a flex child refuses
     to shrink below its content height and the clip is lost.

   Contract: every dialog wraps its middle content in <DialogBody>.
   The legacy auto-wrap shim (DialogScrollShim) was removed once the
   full codebase audit confirmed every DialogContent does so.
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
  }
>(({ className, children, size = "md", onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
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
          // surface / radius / emboss / cyan top-border from .neu-card.
          // Flush because Header + Body + Footer own the inner padding.
          "neu-card neu-card-flush neu-dialog-panel",
          "neu-focus",
          "max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("shrink-0 flex items-start justify-between p-6 pb-4", className)}
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
        // the footer rule is the dark edge of the separator emboss
        "shrink-0 flex items-center justify-end gap-2 border-t border-[color:var(--neu-shadow-dark)] px-6 py-4",
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
