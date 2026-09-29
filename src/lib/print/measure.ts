/* ═══════════════════════════════════════════════════════════════
   RECEIPT HEIGHT MEASUREMENT
   Paper is a continuous roll: the receipt is exactly as long as its
   content. The measurement is deliberately pessimistic about
   asynchrony — Nastaliq ascenders/descenders and late-arriving fonts
   are the classic sources of clipped or shortened receipts:

     1. document.fonts.load() for every family/weight with REAL text
        (Urdu sample included)
     2. await document.fonts.ready
     3. await every img.decode() inside the template (QR/logo)
     4. two animation frames (layout + paint settle)
     5. height = ceil(getBoundingClientRect().height)

   The template renders off-screen at width = profile printable_dots
   mapped to CSS px, DPR 1, no scaling, height auto.
   ═══════════════════════════════════════════════════════════════ */

import {
  renderReceiptBody,
  RECEIPT_FONT_PRELOADS,
  URDU_FONT_FAMILY,
  URDU_FONT_URL,
  type TemplateRenderOptions,
} from "./receipt-template";
import type { ReceiptSnapshot } from "@/lib/receipt-snapshot";
import { formatCurrencyBase } from "@/lib/utils";

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame(resolve));

/** Preload every family/weight the receipt uses, with real text. */
async function loadReceiptFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const loads: Array<Promise<unknown>> = [];
  for (const f of RECEIPT_FONT_PRELOADS) {
    try {
      loads.push(document.fonts.load(`${f.weight} 12px "${f.family}"`, f.text));
    } catch {
      /* font.load can throw on unknown families — proceed with fallback */
    }
  }
  // Latin body font resolves from system families; still wait for ready.
  await Promise.allSettled(loads);
  try {
    await document.fonts.ready;
  } catch {
    /* ready is best-effort */
  }
}

/** Decode every <img> in the container before measuring. */
async function decodeImages(container: HTMLElement): Promise<void> {
  const imgs = Array.from(container.querySelectorAll("img"));
  await Promise.allSettled(imgs.map((img) => img.decode()));
}

/**
 * Attach a @font-face for the bundled Urdu font if the document does
 * not already declare one (the off-screen container may live in a
 * bare measurement document).
 */
function ensureUrduFontFace(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-nsm-receipt-font]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-nsm-receipt-font", "1");
  style.textContent = `@font-face{font-family:"${URDU_FONT_FAMILY}";src:url("${URDU_FONT_URL}") format("woff2");font-weight:400;font-display:block;}`;
  document.head.appendChild(style);
}

export interface MeasuredReceipt {
  /** Rendered height in CSS px (ceil). */
  heightPx: number;
  /** The container that was measured (caller may reuse or detach). */
  container: HTMLDivElement;
}

/**
 * Render the snapshot off-screen and measure its natural height.
 * The caller owns `mount`: a hidden, full-width, overflow-visible
 * position (e.g. body appendix with position:absolute; left:-9999px)
 * so layout happens but nothing is visible.
 */
export async function measureReceipt(
  snapshot: ReceiptSnapshot,
  fmt: (cents: number) => string,
  opts: TemplateRenderOptions,
  mount: HTMLElement
): Promise<MeasuredReceipt> {
  ensureUrduFontFace();
  await loadReceiptFonts();

  const container = document.createElement("div");
  container.setAttribute("data-nsm-receipt-measure", "1");
  container.style.cssText = [
    "position:absolute",
    "left:-99999px",
    "top:0",
    `width:${opts.widthPx}px`,
    "height:auto",
    "visibility:hidden",
    "pointer-events:none",
  ].join(";");
  container.innerHTML = renderReceiptBody(snapshot, fmt, opts);
  mount.appendChild(container);

  // Force layout, settle fonts inside the subtree, decode images,
  // then let two frames pass before reading the box.
  void container.offsetWidth;
  await decodeImages(container);
  await nextFrame();
  await nextFrame();

  const rect = container.getBoundingClientRect();
  return { heightPx: Math.ceil(rect.height), container };
}

/** Convenience wrapper using the money layer as the one formatter. */
export function receiptFormatter(): (cents: number) => string {
  return (cents) => formatCurrencyBase(cents);
}

/**
 * Detach a measured container (call after rasterizing or on abort).
 */
export function disposeMeasuredReceipt(container: HTMLDivElement): void {
  container.remove();
}
