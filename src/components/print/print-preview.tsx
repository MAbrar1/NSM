"use client";

/* ═══════════════════════════════════════════════════════════════
   GLOBAL PRINT PREVIEW
   Renders any pure print-document builder (`buildReportHtml`,
   `buildPurchaseOrderHtml`, …) in a full-height in-app modal so
   users can eyeball the A4 output before printing — no print
   dialog, no popup-permission round trip. Mirrored documents
   (RTL/Urdu) preview exactly as they will print. "Print" and
   "Download HTML" hand the same bytes to the browser.

   SCHEMES — Light / Dark / System:
   The segmented control restyles the previewed document in place
   (the palette lives in print-brand.ts). "System" follows the OS
   prefers-color-scheme via a `data-scheme="auto"` attribute that
   the document's @media query resolves. The choice persists in
   localStorage. PAPER OUTPUT IS ALWAYS LIGHT — @media print inside
   every document forces the light palette regardless of this
   toggle; dark is an on-screen comfort feature only.

   PAGE-COUNT ESTIMATE: the document reports its own rendered
   height through a postMessage handshake (A4 @page boxes minus
   12mm/10mm margins → sheets needed). A4 = 297mm tall.

   The dialog is opened through `usePreviewStore()` so any page
   can preview without prop-drilling:
     usePreviewStore.getState().show(html, "document.html");
   ═══════════════════════════════════════════════════════════════ */

import { create } from "zustand";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/components/providers/i18n-provider";
import { PRINT_SCHEME_STORAGE_KEY, PRINT_SCHEME_COOKIE, type PrintScheme } from "@/lib/print-brand";

type Scheme = PrintScheme;

interface PreviewState {
  /** Raw document HTML (null = closed). Kept so the iframe data
   *  URL can be rebuilt when the scheme toggles. */
  html: string | null;
  /** Data URL of the (scheme-baked) document, for the sandboxed iframe. */
  src: string | null;
  filename: string;
  scheme: Scheme;
  show: (html: string, filename: string) => void;
  setScheme: (scheme: Scheme) => void;
  hide: () => void;
}

/**
 * Read the persisted preview scheme. localStorage is primary
 * (per-browser preference); the cookie is a fallback so the
 * choice survives on http:// LAN terminals, in private windows,
 * and when storage is partitioned.
 */
function storedScheme(): Scheme {
  try {
    const v = localStorage.getItem(PRINT_SCHEME_STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* fall through to the cookie */
  }
  try {
    const m = document.cookie.match(/(?:^|;\s*)najjar-print-scheme=(light|dark|system)(?:;|$)/);
    if (m) return m[1] as Scheme;
  } catch {
    /* ignore */
  }
  return "system";
}

/**
 * Bake the chosen scheme onto the document root before encoding.
 * - light → strip any data-scheme attribute (CSS default is light)
 * - dark  → force data-scheme="dark"
 * - system→ leave the bootstrap script in charge (it sets "auto"
 *   from the persisted choice); also set it directly in case the
 *   document was built without the script.
 */
function withScheme(html: string, scheme: Scheme): string {
  if (scheme === "light") return html.replace(/\s*data-scheme="[^"]*"/, "");
  if (scheme === "dark") {
    return html.includes("data-scheme=")
      ? html.replace(/data-scheme="[^"]*"/, 'data-scheme="dark"')
      : html.replace("<html ", '<html data-scheme="dark" ');
  }
  // system: prefer the document's own bootstrap; make sure an
  // attribute exists so the media query can match even pre-script.
  return html.includes("data-scheme=")
    ? html
    : html.replace("<html ", '<html data-scheme="auto" ');
}

/**
 * Preview-only chrome: the document's ruler builder renders break
 * markers only when the root carries data-preview="1". Downloaded
 * HTML keeps this attribute OUT — the file must not ship editor
 * chrome.
 */
function withPreviewChrome(html: string): string {
  return html.replace("<html ", '<html data-preview="1" ');
}

function buildSrc(html: string, scheme: Scheme): string {
  // A data-URL iframe + sandbox="allow-modals allow-same-origin"
  // makes the frame's print() work in Chromium without popup
  // permission — the whole point of previewing in-app. The preview
  // attribute enables the page-break ruler inside the frame only.
  //
  // Bundled fonts: the frame is an opaque-origin data: URL, so the
  // documents' root-relative /fonts/... URLs cannot resolve inside it
  // and Urdu/Arabic would silently fall back. Absolutize them against
  // the app origin (same files the print windows load — no network).
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const prepared = withScheme(html, scheme).replaceAll(
    /url\(("?)\/fonts\//g,
    `url($1${origin}/fonts/`
  );
  return `data:text/html;charset=utf-8;base64,${base64EncodeUtf8(withPreviewChrome(prepared))}`;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  html: null,
  src: null,
  filename: "document.html",
  scheme: "system",
  show: (html, filename) => {
    const scheme = storedScheme();
    set({ html, src: buildSrc(html, scheme), filename, scheme });
  },
  setScheme: (scheme) => {
    const { html, filename } = get();
    if (!html) return;
    try {
      localStorage.setItem(PRINT_SCHEME_STORAGE_KEY, scheme);
    } catch {
      /* private mode — cookie write-through below still applies */
    }
    // Cookie write-through: SameSite=Lax, 1 year. Keeps the choice
    // available to any future server-rendered document shells.
    try {
      document.cookie = `${PRINT_SCHEME_COOKIE}=${scheme}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* ignore */
    }
    set({ scheme, src: buildSrc(html, scheme), filename });
  },
  hide: () => set({ html: null, src: null }),
}));

/** Unicode-safe base64 (btoa alone chokes on Urdu text). */
function base64EncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Trigger a client-side download of the exact document being previewed. */
function downloadHtmlFile(html: string, stem: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${stem}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ── scheme segmented control ──────────────────────────────────── */

function SchemeIcon({ scheme }: { scheme: Scheme }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (scheme === "dark") return <svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;
  if (scheme === "system")
    return (
      <svg {...common}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function SchemeToggle({
  scheme,
  onChange,
  systemDark,
}: {
  scheme: Scheme;
  onChange: (s: Scheme) => void;
  /** Live OS preference, used to label the System segment. */
  systemDark: boolean;
}) {
  const { t } = useI18n();
  const options: Array<{ value: Scheme; label: string }> = [
    { value: "light", label: t("common.schemeLight") },
    { value: "dark", label: t("common.schemeDark") },
    { value: "system", label: `${t("common.schemeSystem")} (${systemDark ? t("common.schemeDark") : t("common.schemeLight")})` },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t("common.previewScheme")}
      className="flex items-center rounded-lg border border-neu-hairline bg-neu-sunken p-0.5"
    >
      {options.map((o) => {
        const active = scheme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-neu-bg text-neu-primary shadow-sm"
                : "text-neu-faint hover:text-neu-primary"
            }`}
          >
            <SchemeIcon scheme={o.value} />
            <span className="hidden md:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── page-count handshake ──────────────────────────────────────── */

/** Matches the measurement script embedded in the print engines. */
interface PageMeasureMessage {
  type: "najjar-print-page-info";
  contentHeight: number;
  contentWidth: number;
  /** Page count the document computed from its own sheet element. */
  pageCount?: number;
}

/** Scroll position broadcast from the previewed document. */
interface PageScrollMessage {
  type: "najjar-print-scroll";
  /** 1-based page currently at the top of the viewport. */
  page: number;
}

const A4_HEIGHT_MM = 297;
/** Mirrors the engines' `@page { margin: 12mm 10mm }`. */
const PAGE_MARGIN_MM = 24;
const MM_PER_PX = 25.4 / 96;

function estimatePages(contentHeightPx: number): number {
  const usableMm = A4_HEIGHT_MM - PAGE_MARGIN_MM;
  const usablePx = usableMm / MM_PER_PX;
  // Fractional sheets count as a page (round up), floor of 1.
  return Math.max(1, Math.ceil(contentHeightPx / usablePx));
}

export function PrintPreviewProvider() {
  const { t } = useI18n();
  const html = usePreviewStore((s) => s.html);
  const src = usePreviewStore((s) => s.src);
  const filename = usePreviewStore((s) => s.filename);
  const scheme = usePreviewStore((s) => s.scheme);
  const setScheme = usePreviewStore((s) => s.setScheme);
  const hide = usePreviewStore((s) => s.hide);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [systemDark, setSystemDark] = useState(false);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  /* Track the OS color scheme so the System segment can label itself. */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* Receive the document's measured height from the sandboxed iframe. */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as PageMeasureMessage | PageScrollMessage | undefined;
      if (d && d.type === "najjar-print-page-info" && typeof d.contentHeight === "number" && d.contentHeight > 0) {
        // Prefer the document's own count (it measures the real sheet);
        // fall back to the px→mm estimate for older documents.
        setPageCount(typeof d.pageCount === "number" && d.pageCount > 0 ? d.pageCount : estimatePages(d.contentHeight));
      }
      if (d && d.type === "najjar-print-scroll" && typeof d.page === "number") {
        setCurrentPage(Math.max(1, d.page));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /* Reset the estimate when a document loads or the scheme changes
     (layout heights shift slightly between palettes). */
  useEffect(() => {
    setPageCount(null);
    setCurrentPage(1);
  }, [src]);

  const pages = pageCount ?? 0;
  const jump = (page: number) => {
    const p = Math.min(Math.max(1, page), Math.max(pages, 1));
    iframeRef.current?.contentWindow?.postMessage({ type: "najjar-print-go-page", page: p }, "*");
    setCurrentPage(p);
  };

  /* Keyboard paging: PgUp/PgDn + direction-aware arrows while the
     modal is open. If focus sits on the iframe itself the document's
     own handler responds (identical logic); this effect covers the
     rest of the modal chrome. Inputs are excluded. */
  useEffect(() => {
    if (pageCount == null || pageCount < 2) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const tag = (ev.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (ev.target as HTMLElement | null)?.isContentEditable) return;
      const rtl = document.documentElement.getAttribute("dir") === "rtl";
      let target = 0;
      if (ev.key === "PageDown" || (ev.key === "ArrowRight" && !rtl) || (ev.key === "ArrowLeft" && rtl)) target = currentPage + 1;
      else if (ev.key === "PageUp" || (ev.key === "ArrowLeft" && !rtl) || (ev.key === "ArrowRight" && rtl)) target = currentPage - 1;
      else if (ev.key === "Home") target = 1;
      else if (ev.key === "End") target = pageCount;
      if (target > 0) {
        ev.preventDefault();
        jump(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jump reads currentPage/pages via closure
  }, [pageCount, currentPage]);

  if (src === null) return null;

  return (
    <Dialog open={src !== null} onOpenChange={(o) => !o && hide()}>
      <DialogContent className="flex h-[92dvh] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b border-neu-hairline px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3 pr-8">
            <DialogTitle>{t("common.printPreview")}</DialogTitle>
            <div className="flex items-center gap-2">
              <SchemeToggle scheme={scheme} onChange={setScheme} systemDark={systemDark} />
            </div>
          </div>
          <DialogDescription className="sr-only">{t("common.printPreviewHint")}</DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 bg-neu-sunken p-0">
          {src !== null && (
            <iframe
              title={t("common.printPreview")}
              className="h-full w-full border-0 bg-white"
              src={src}
              ref={iframeRef}
              sandbox="allow-modals allow-same-origin"
            />
          )}
        </DialogBody>

        <DialogFooter className="items-center justify-between gap-2 border-t border-neu-hairline px-4 py-3">
          <p className="hidden text-xs text-neu-faint sm:block">
            {pageCount != null
              ? t("common.pageEstimate").replace("{n}", String(pageCount))
              : t("common.printPreviewHint")}
          </p>
          <div className="flex items-center gap-2">
            {pageCount != null && pageCount > 1 && (
              <div className="mr-1 flex items-center gap-1 rounded-lg border border-neu-hairline bg-neu-sunken p-0.5">
                <button
                  type="button"
                  onClick={() => jump(currentPage - 1)}
                  disabled={currentPage <= 1}
                  aria-label={t("common.prevPage")}
                  title={t("common.prevPage")}
                  className="rounded-md px-1.5 py-1 text-neu-faint transition-colors hover:bg-neu-bg hover:text-neu-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <span className="min-w-[92px] text-center text-xs font-medium tabular-nums text-neu-muted">
                  {t("common.pageOf").replace("{page}", String(currentPage)).replace("{n}", String(pageCount))}
                </span>
                <button
                  type="button"
                  onClick={() => jump(currentPage + 1)}
                  disabled={currentPage >= pageCount}
                  aria-label={t("common.nextPage")}
                  title={t("common.nextPage")}
                  className="rounded-md px-1.5 py-1 text-neu-faint transition-colors hover:bg-neu-bg hover:text-neu-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </div>
            )}
            <Button variant="ghost" onClick={() => html && downloadHtmlFile(html, filename.replace(/\.html$/, ""))}>
              {t("common.downloadHtml")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                iframeRef.current?.contentWindow?.print();
              }}
            >
              {t("common.print")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Fire-and-forget opener for non-React contexts (lib helpers). */
export function openPrintPreview(html: string, filename: string): void {
  usePreviewStore.getState().show(html, filename);
}
