"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   SMART IMAGE — the one image renderer every surface shares.

   bulletproof against "bad" uploads of any height/width:
   - object-fit: cover crops oversized/mismatched ratios gracefully
     (smart centering keeps the subject visible, heads not cut off)
   - object-fit: contain for ultra-wide / ultra-tall images (logos,
     banners, scans) that would be unrecognizable when cropped —
     with a transparent checkerboard behind them so they never
     touch raw borders
   - transparency-preserving: PNG/WebP alpha renders over a soft
     surface tile, never a black box
   - broken/removed file → retry once → clean SVG placeholder
     (never a broken-image glyph, never a blank hole)
   - tiny placeholder shimmer while loading
   - layout-safe: wrapper carries the size, the img never overflows
   ═══════════════════════════════════════════════════════════════ */

/** Fine-tuning knobs for subject-visibility heuristics. */
export type SmartImageFit = "cover" | "contain";
export type SmartImagePosition = "center" | "top";

export interface SmartImageProps {
  src?: string | null;
  alt: string;
  /** Sizing classes live on the wrapper (e.g. "h-11 w-11 rounded-lg"). */
  className?: string;
  /** Sizing classes for the svg icon when no image can render. */
  iconClassName?: string;
  /** Force one fit instead of the auto decision. */
  fit?: SmartImageFit;
  /** Subject anchor used when cropping (cover). */
  position?: SmartImagePosition;
  /** Opt out of the zoom hover (e.g. 1px avatars, ghost buttons). */
  zoomOnHover?: boolean;
  /**
   * Wrap the image in the neu picture frame (8px padding, raised
   * emboss, inner radius = frame radius − 8px).
   *
   * Opt-in, deliberately: SmartImage's wrapper is size-owned by its
   * caller (44px avatars, full-bleed POS tile art, gallery cells all
   * pass h-/w- classes). Imposing 8px of padding and a raised emboss
   * on every slot would break those layouts, so the frame is applied
   * only where a standalone framed image is actually wanted — the
   * lightbox uses it, and so can any caller via this prop.
   *
   * Either way the `<img>` itself is never given a shadow — only the
   * frame is.
   */
  framed?: boolean;
  title?: string;
  loading?: "lazy" | "eager";
}

/** Natural dimensions fetched without layout impact. */
async function probeDimensions(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("probe failed"));
    img.src = src;
  });
}

/** Should this aspect ratio be letterboxed instead of cropped? */
function wantsContain(w: number, h: number): boolean {
  const ratio = w / Math.max(1, h);
  return ratio > 2.6 || ratio < 1 / 2.6;
}

const BOX_PATH =
  "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4";

export function SmartImage({
  src,
  alt,
  className,
  iconClassName,
  fit,
  position = "center",
  zoomOnHover = true,
  framed = false,
  title,
  loading = "lazy",
}: SmartImageProps) {
  const [failed, setFailed] = React.useState(false);
  const [retried, setRetried] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [autoFit, setAutoFit] = React.useState<SmartImageFit | null>(null);

  // Reset whenever the source changes (replace/edit flows re-render
  // with a brand-new URL on the same mounted component).
  React.useEffect(() => {
    setFailed(false);
    setRetried(false);
    setLoaded(false);
    setAutoFit(null);
  }, [src]);

  // Auto-detect extreme aspect ratios (once) and letterbox them.
  React.useEffect(() => {
    if (!src || failed || fit) return;
    let cancelled = false;
    probeDimensions(src)
      .then(({ w, h }) => {
        if (!cancelled) setAutoFit(wantsContain(w, h) ? "contain" : "cover");
      })
      .catch(() => {
        /* if the probe fails the <img> will fail too — handled there */
      });
    return () => {
      cancelled = true;
    };
  }, [src, failed, fit]);

  const effectiveFit: SmartImageFit = fit ?? autoFit ?? "cover";
  const showImage = Boolean(src) && !failed;

  return (
    <div
      className={cn(
        "smart-image",
        // frame only when asked — see the `framed` prop contract above
        framed && "neu-image-frame",
        zoomOnHover && "smart-image-zoom",
        effectiveFit === "contain" && "smart-image-contain",
        !loaded && showImage && "smart-image-loading",
        className
      )}
      title={title}
    >
      {showImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src ?? undefined}
            alt={alt}
            title={title}
            loading={loading}
            decoding="async"
            className={cn(
              "smart-image-img",
              position === "top" && "smart-image-img-top"
            )}
            style={{ objectFit: effectiveFit }}
            onLoad={(e) => {
              // Belt & braces: even if the probe raced/failed, decide
              // from the actual element's natural size.
              const el = e.currentTarget;
              if (!fit && el.naturalWidth && el.naturalHeight) {
                setAutoFit(wantsContain(el.naturalWidth, el.naturalHeight) ? "contain" : "cover");
              }
              setLoaded(true);
            }}
            onError={() => {
              // One silent retry (transient network), then placeholder.
              if (!retried) {
                setRetried(true);
                return;
              }
              setFailed(true);
            }}
          />
          {/* Retry: cache-busted reload gives the file route a second chance. */}
          {retried && (
            <img
              src={`${src}${src!.includes("?") ? "&" : "?"}__retry=1`}
              alt=""
              aria-hidden="true"
              className="hidden"
              onError={() => setFailed(true)}
              onLoad={(e) => {
                const target = e.currentTarget;
                const visible = target.previousElementSibling as HTMLImageElement | null;
                if (visible) visible.src = target.src;
                setRetried(false);
              }}
            />
          )}
        </>
      ) : (
        <svg
          className={cn("smart-image-icon", iconClassName ?? "h-5 w-5")}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d={BOX_PATH} />
        </svg>
      )}
    </div>
  );
}

/** Same box path, exported for hand-rolled empty states. */
export const SMART_IMAGE_BOX_PATH = BOX_PATH;
