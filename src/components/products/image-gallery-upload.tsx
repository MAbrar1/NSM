"use client";

import * as React from "react";
import { SmartImage } from "@/components/ui/smart-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/components/providers/i18n-provider";
import { toast } from "@/stores/toast-store";
import { normalizeImageFile } from "@/lib/files/image-normalize";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   IMAGE GALLERY UPLOAD
   Drag-and-drop + click-to-browse image uploader for products.

   Every dropped/selected file is NORMALIZED client-side first
   (auto-orient, downscale to ≤2048px, transparency-aware encode),
   so any height/width upload ends up stored in a uniform,
   fast, display-perfect form. Thumbnails render through
   SmartImage, so even legacy irregular images look right.

   Per-image actions: preview (lightbox), replace, move ←/→,
   remove. First image is the primary/cover.
   ═══════════════════════════════════════════════════════════════ */

interface ImageGalleryUploadProps {
  productId: string;
  existingImages?: string[];
  onImagesChange?: (images: string[]) => void;
  maxImages?: number;
}

export function ImageGalleryUpload({
  productId,
  existingImages = [],
  onImagesChange,
  maxImages = 6,
}: ImageGalleryUploadProps) {
  const { t } = useI18n();
  const [images, setImages] = React.useState<string[]>(existingImages);
  const [uploading, setUploading] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [lightbox, setLightbox] = React.useState<number | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Index being replaced; null when the input is adding new images.
  const replaceIndexRef = React.useRef<number | null>(null);
  // Internal DnD state: index currently dragged + hovered drop target.
  // Both live on refs (instant updates, no re-render churn); the
  // drag-over target is mirrored to state purely for the CSS highlight.
  const dragIndexRef = React.useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = React.useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = React.useState<number | null>(null);
  // “External drop” = a file was dragged over the grid itself — the whole
  // grid becomes a drop zone for adding/replacing images.
  const [gridFileOver, setGridFileOver] = React.useState(false);

  /* ─── Long-press touch reordering (mobile) ───
     Hold a tile ~400ms to lift it, then drag; release to drop.
     React's onTouchMove is a PASSIVE listener, so scroll-blocking
     preventDefault() is done via native document listeners added on
     touchstart and removed on release. A 10px slop radius cancels the
     hold when the finger is really scrolling. */
  const LONG_PRESS_MS = 400;
  const SLOP_PX = 10;
  const pressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const touchActiveRef = React.useRef(false);
  const touchOverRef = React.useRef<number | null>(null);
  const [touchOverIndex, setTouchOverIndex] = React.useState<number | null>(null);

  // Always-fresh reorder for the stable document listeners below.
  const reorderRef = React.useRef(reorderImages);
  reorderRef.current = reorderImages;

  function clearPressTimer() {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }

  const onDocTouchMove = React.useCallback((e: TouchEvent) => {
    if (!touchActiveRef.current) {
      // Hold not (yet) activated — cancel it if the finger scrolled.
      const start = touchStartRef.current;
      const tch = e.touches[0];
      if (start && tch) {
        const dx = tch.clientX - start.x;
        const dy = tch.clientY - start.y;
        if (dx * dx + dy * dy > SLOP_PX * SLOP_PX) {
          clearPressTimer();
          touchStartRef.current = null;
          dragIndexRef.current = null;
        }
      }
      return;
    }
    // Active touch-drag: block page scroll and track the drop target.
    e.preventDefault();
    const tch = e.touches[0];
    if (!tch) return;
    const el = document.elementFromPoint(tch.clientX, tch.clientY);
    const tile = el?.closest?.("[data-gallery-index]");
    const target = tile ? Number(tile.getAttribute("data-gallery-index")) : NaN;
    if (Number.isFinite(target)) {
      if (touchOverRef.current !== target) {
        touchOverRef.current = target;
        setTouchOverIndex(target);
      }
    } else if (touchOverRef.current !== null) {
      touchOverRef.current = null;
      setTouchOverIndex(null);
    }
  }, []);

  const onDocTouchEnd = React.useCallback(() => {
    // Commit the reorder if a valid target was hovered.
    if (touchActiveRef.current && dragIndexRef.current !== null && touchOverRef.current !== null) {
      reorderRef.current(dragIndexRef.current, touchOverRef.current);
    }
    touchActiveRef.current = false;
    setTouchDragging(false);
    setDraggingIndex(null);
    setTouchOverIndex(null);
    touchOverRef.current = null;
    dragIndexRef.current = null;
    touchStartRef.current = null;
    clearPressTimer();
    document.removeEventListener("touchmove", onDocTouchMove);
    document.removeEventListener("touchend", onDocTouchEnd);
    document.removeEventListener("touchcancel", onDocTouchEnd);
  }, [onDocTouchMove]);

  const [touchDragging, setTouchDragging] = React.useState(false);

  function handleTouchStart(e: React.TouchEvent, index: number) {
    if (e.touches.length !== 1) return; // ignore pinch/multi-touch
    const tch = e.touches[0]!;
    touchStartRef.current = { x: tch.clientX, y: tch.clientY };
    dragIndexRef.current = index;
    clearPressTimer();
    pressTimerRef.current = setTimeout(() => {
      pressTimerRef.current = null;
      touchStartRef.current = null; // slop-cancel no longer applies
      touchActiveRef.current = true;
      setTouchDragging(true);
      setDraggingIndex(index); // reuse the lifted-source visual
      setTouchOverIndex(index);
      touchOverRef.current = index;
      // Subtle haptic tick where supported (Android).
      try {
        navigator.vibrate?.(10);
      } catch {
        /* unsupported — fine */
      }
    }, LONG_PRESS_MS);
    // Native non-passive listeners for the whole gesture.
    document.addEventListener("touchmove", onDocTouchMove, { passive: false });
    document.addEventListener("touchend", onDocTouchEnd);
    document.addEventListener("touchcancel", onDocTouchEnd);
  }

  // Remove listeners if the component unmounts mid-gesture.
  React.useEffect(() => {
    return () => {
      clearPressTimer();
      document.removeEventListener("touchmove", onDocTouchMove);
      document.removeEventListener("touchend", onDocTouchEnd);
      document.removeEventListener("touchcancel", onDocTouchEnd);
    };
  }, [onDocTouchMove, onDocTouchEnd]);

  // Sync with parent if existingImages changes
  React.useEffect(() => {
    setImages(existingImages);
  }, [existingImages]);

  const notifyChange = React.useCallback(
    (newImages: string[]) => {
      setImages(newImages);
      onImagesChange?.(newImages);
    },
    [onImagesChange]
  );

  // Normalize + upload a single file. The API reads the multipart
  // field named "image".
  async function uploadFile(file: File): Promise<string | null> {
    let toSend = file;
    try {
      const norm = await normalizeImageFile(file);
      toSend = norm.file;
    } catch {
      /* normalization is best-effort — upload the original */
    }
    const formData = new FormData();
    formData.append("image", toSend);

    try {
      const res = await fetch(`/api/products/${productId}/image`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(t("common.error"), typeof data.error === "string" ? data.error : t("common.uploadFailed"));
        return null;
      }

      const data = await res.json();
      return data.imageUrl ?? data.url ?? null;
    } catch {
      toast.error(t("common.networkError"), t("common.networkErrorDesc"));
      return null;
    }
  }

  // Handle file selection (click or drop, add or replace)
  async function handleFiles(files: FileList | File[]) {
    const fileArray = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (fileArray.length === 0) return;

    // Replacing a specific slot: one file, same position.
    const replacing = replaceIndexRef.current;
    replaceIndexRef.current = null;
    if (replacing !== null) {
      setUploading(true);
      const url = await uploadFile(fileArray[0]!);
      if (url) {
        const next = [...images];
        next[replacing] = url;
        notifyChange(next);
        toast.success(t("common.success"), t("products.form.imagesUploaded").replace("{n}", "1"));
      }
      setUploading(false);
      return;
    }

    const remaining = maxImages - images.length;
    if (remaining <= 0) {
      toast.error(t("common.error"), t("products.form.maxImagesReached").replace("{max}", String(maxImages)));
      return;
    }

    const toUpload = fileArray.slice(0, remaining);
    if (toUpload.length < fileArray.length) {
      toast.info(t("common.info"), t("products.form.onlyNMore").replace("{n}", String(remaining)));
    }

    setUploading(true);
    const uploadedUrls: string[] = [];

    for (const file of toUpload) {
      const url = await uploadFile(file);
      if (url) uploadedUrls.push(url);
    }

    if (uploadedUrls.length > 0) {
      const newImages = [...images, ...uploadedUrls];
      notifyChange(newImages);
      toast.success(t("common.success"), t("products.form.imagesUploaded").replace("{n}", String(uploadedUrls.length)));
    }

    setUploading(false);
  }

  // Drag-and-drop handlers
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }

  /** Replace flow: open the picker scoped to one slot. */
  function startReplace(index: number) {
    replaceIndexRef.current = index;
    fileInputRef.current?.click();
  }

  // Drop the file from the gallery (the PUT handler deletes the file).
  function removeImage(index: number) {
    notifyChange(images.filter((_, i) => i !== index));
  }

  // Reorder images (move left/right)
  function moveImage(fromIndex: number, direction: "left" | "right") {
    const toIndex = direction === "left" ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= images.length) return;
    reorderImages(fromIndex, toIndex);
  }

  /** Single source of truth for any reorder (buttons + HTML5 DnD). */
  function reorderImages(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    const newImages = [...images];
    const [moved] = newImages.splice(fromIndex, 1);
    newImages.splice(toIndex, 0, moved!);
    notifyChange(newImages);
  }

  /* ─── HTML5 drag-to-reorder ───
     draggable tiles + drop targets. Files dragged from the OS have
     type "Files" — those fall through to the add/replace handlers. */

  function handleItemDragStart(e: React.DragEvent, index: number) {
    // Must be setData for Firefox to even start the drag.
    e.dataTransfer.setData("text/plain", String(index));
    e.dataTransfer.effectAllowed = "move";
    dragIndexRef.current = index;
    setDraggingIndex(index);
  }

  function handleItemDragOver(e: React.DragEvent, index: number) {
    if (dragIndexRef.current === null) {
      // External file drag — accept files dropped anywhere on the grid.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!gridFileOver) setGridFileOver(true);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverIndex !== index) setDragOverIndex(index);
  }

  function handleItemDragLeave(index: number) {
    if (dragOverIndex === index) setDragOverIndex(null);
    if (gridFileOver) setGridFileOver(false);
  }

  function handleItemDrop(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    // Case 1: internal tile drag → reorder.
    if (dragIndexRef.current !== null) {
      reorderImages(dragIndexRef.current, index);
      dragIndexRef.current = null;
      setDraggingIndex(null);
      setDragOverIndex(null);
      return;
    }
    // Case 2: external file(s) → replace this slot (single file) or
    // fall through to add (handled by the upload zone only).
    if (e.dataTransfer.files.length > 0) {
      replaceIndexRef.current = index;
      void handleFiles(e.dataTransfer.files);
    }
    setGridFileOver(false);
  }

  function handleItemDragEnd() {
    dragIndexRef.current = null;
    setDraggingIndex(null);
    setDragOverIndex(null);
    setGridFileOver(false);
  }

  return (
    <div className="space-y-3">
      {/* Upload area */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => {
          replaceIndexRef.current = null;
          fileInputRef.current?.click();
        }}
        className={cn(
          "relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 transition-all",
          dragOver
            ? "border-neu-accent-line bg-neu-accent-wash"
            : "border-neu-hairline hover:border-neu-accent-line hover:bg-neu-sunken",
          uploading && "pointer-events-none opacity-60"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {uploading ? (
          <div className="text-center">
            <Spinner size="lg" className="mx-auto mb-2 h-8 w-8 text-neu-accent-line" />
            <p className="text-sm text-neu-faint">{t("common.uploading")}</p>
          </div>
        ) : (
          <div className="text-center">
            <svg className="mx-auto h-10 w-10 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <p className="mt-2 text-sm font-medium text-neu-primary">
              {dragOver ? t("products.form.dropImagesHere") : t("products.form.dragDropImages")}
            </p>
            <p className="mt-1 text-xs text-neu-faint">
              {t("products.form.imageFormats")} · {images.length}/{maxImages}
            </p>
          </div>
        )}
      </div>

      {/* Image gallery grid — draggable to reorder; also a drop zone
          for external files (drop on a tile = replace it). */}
      {images.length > 0 && (
        <div
          className={cn("gallery-grid", gridFileOver && "gallery-grid-file-over")}
          onDragOver={(e) => {
            // Grid-level file acceptance when not dragging a tile.
            if (dragIndexRef.current === null) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (!gridFileOver) setGridFileOver(true);
            }
          }}
          onDrop={(e) => {
            // Files dropped on grid padding/gaps (not a tile) = append.
            if (dragIndexRef.current === null && e.dataTransfer.files.length > 0) {
              e.preventDefault();
              void handleFiles(e.dataTransfer.files);
            }
            setGridFileOver(false);
          }}
        >
          {images.map((src, index) => (
            <div
              key={`${src}-${index}`}
              data-gallery-index={index}
              className={cn(
                "gallery-item group",
                draggingIndex === index && "gallery-item-dragging",
                touchDragging && draggingIndex === index && "gallery-item-touch-lift",
                dragOverIndex === index && dragIndexRef.current !== index && "gallery-item-drop-target",
                touchOverIndex === index && dragIndexRef.current !== index && "gallery-item-drop-target"
              )}
              draggable
              onDragStart={(e) => handleItemDragStart(e, index)}
              onDragOver={(e) => handleItemDragOver(e, index)}
              onDragLeave={() => handleItemDragLeave(index)}
              onDrop={(e) => handleItemDrop(e, index)}
              onDragEnd={handleItemDragEnd}
              onTouchStart={(e) => handleTouchStart(e, index)}
            >
              <SmartImage
                src={src}
                alt={t("products.form.imageAlt").replace("{n}", String(index + 1))}
                className="w-full h-full"
              />

              {/* Drag handle hint (overlay icon, bottom-right) */}
              <span className="gallery-drag-hint" aria-hidden="true">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m5-7H3" transform="rotate(90 12 12)" />
                </svg>
              </span>

              {/* Primary badge */}
              {index === 0 && (
                <span className="primary-badge">
                  {t("products.form.primaryImage")}
                </span>
              )}

              {/* Hover controls */}
              <div className="gallery-hover-controls">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setLightbox(index); }}
                  className="gallery-control-btn"
                  title={t("products.preview")}
                  aria-label={t("products.preview")}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); startReplace(index); }}
                  className="gallery-control-btn"
                  title={t("products.form.replaceImage")}
                  aria-label={t("products.form.replaceImage")}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                </button>
                {index > 0 && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); moveImage(index, "left"); }}
                    className="gallery-control-btn"
                    title={t("products.form.moveImageLeft")}
                    aria-label={t("products.form.moveImageLeft")}
                  >
                    <svg className="h-3.5 w-3.5 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                  </button>
                )}
                {index < images.length - 1 && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); moveImage(index, "right"); }}
                    className="gallery-control-btn"
                    title={t("products.form.moveImageRight")}
                    aria-label={t("products.form.moveImageRight")}
                  >
                    <svg className="h-3.5 w-3.5 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeImage(index); }}
                  className="gallery-control-btn gallery-control-btn-danger"
                  title={t("common.remove")}
                  aria-label={t("common.remove")}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Full-screen preview */}
      <ImageLightbox
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
        images={images}
        initialIndex={lightbox ?? 0}
        alt={t("products.form.images")}
      />
    </div>
  );
}
