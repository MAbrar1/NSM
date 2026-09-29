"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/providers/i18n-provider";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   IMAGE LIGHTBOX — full-screen preview shared by every surface.

   - fits any height/width perfectly (contain, max 92vw/88vh)
   - arrow keys / on-screen arrows navigate a gallery
   - Escape / backdrop click to dismiss
   - body scroll locked while open; RTL-safe chrome
   ═══════════════════════════════════════════════════════════════ */

export interface ImageLightboxProps {
  open: boolean;
  onClose: () => void;
  /** Gallery entries in display order. */
  images: string[];
  /** Index of the image to show when opened. */
  initialIndex?: number;
  alt: string;
}

export function ImageLightbox({
  open,
  onClose,
  images,
  initialIndex = 0,
  alt,
}: ImageLightboxProps) {
  const { t } = useI18n();
  const [index, setIndex] = React.useState(initialIndex);
  const [mounted, setMounted] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // It declares `role="dialog" aria-modal="true"`, so it owes the modal
  // keyboard contract: focus in on open, Tab contained, focus back to the
  // thumbnail that opened it on close.
  useModalFocus(open, rootRef);

  React.useEffect(() => setMounted(true), []);

  // (Re)sync selection whenever the lightbox is opened.
  React.useEffect(() => {
    if (open) setIndex(Math.min(Math.max(0, initialIndex), Math.max(0, images.length - 1)));
  }, [open, initialIndex, images.length]);

  const hasMultiple = images.length > 1;
  const go = React.useCallback(
    (delta: number) =>
      setIndex((i) => (i + delta + images.length) % images.length),
    [images.length]
  );

  // Keyboard: arrows + Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasMultiple) go(-1);
      else if (e.key === "ArrowRight" && hasMultiple) go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, go, hasMultiple]);

  // Lock body scroll while open.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      ref={rootRef}
      className="lightbox-root"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label={t("common.close")}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {hasMultiple && (
        <>
          <button
            type="button"
            className="lightbox-arrow lightbox-arrow-start"
            onClick={(e) => { e.stopPropagation(); go(-1); }}
            aria-label={t("common.previous")}
          >
            <svg className="h-6 w-6 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <button
            type="button"
            className="lightbox-arrow lightbox-arrow-end"
            onClick={(e) => { e.stopPropagation(); go(1); }}
            aria-label={t("common.next")}
          >
            <svg className="h-6 w-6 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </>
      )}

      {/* The neu frame owns the emboss — the <img> never gets a shadow.
          stopPropagation so clicking the image itself doesn't close. */}
      <div
        className="neu-image-frame lightbox-frame"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={images[index]}
          src={images[index]}
          alt={alt}
          className={cn("lightbox-img", hasMultiple && "lightbox-img-cursor")}
        />
      </div>

      {hasMultiple && (
        <div className="lightbox-counter" onClick={(e) => e.stopPropagation()}>
          {index + 1} / {images.length}
        </div>
      )}
    </div>,
    document.body
  );
}
