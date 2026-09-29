/* ═══════════════════════════════════════════════════════════════
   PRINT BRAND — one palette for every exported surface

   The ACCENT mirrors the neu interactive accent tokens in
   src/app/globals.css, so printed A4 documents, the Excel header
   band and the on-screen UI all read as the same product (cyan).
   The NEUTRALS mirror the legacy `--color-surface-*` ladder, which
   is still the shared ink scale for paper: a document wants a plain
   near-black ink, not a neumorphic mid-tone.

   `tests/print-brand-sync.test.ts` parses globals.css and fails if
   either half drifts.
   ═══════════════════════════════════════════════════════════════ */

/* Pure constants only — this module is imported by the client bundle
   (via print-report.ts), so it must NOT pull in node builtins like
   node:fs. The test-side CSS parser lives in the test file itself. */

/** Brand + neutrals used by the print engines and the Excel writer. */
export const PRINT_BRAND = {
  /** --neu-accent-ink — primary accent (title band border, chips).
   *  Chosen for PAPER: #155e75 is 7.27:1 on white, where the screen's
   *  `--neu-accent-line` (#0891b2) would only be 3.6:1. */
  brand: "#155e75",
  /** --neu-accent-ink-strong — darker accent (section titles, gradient end). */
  brandDark: "#164e63",
  /** --neu-accent-tint — lightest accent tint (band fills on paper). */
  brandTint: "#cbe1e9",
  /** --color-surface-900 — body ink. */
  ink: "#0f172a",
  /** --color-surface-500 — secondary text. */
  muted: "#64748b",
  /** --color-surface-200 — hairlines. */
  line: "#e2e8f0",
  /** --color-surface-50 — zebra rows. */
  zebra: "#f8fafc",
  /** --color-surface-100 — header band. */
  band: "#f1f5f9",
  /** --color-success-700 — positive tone. */
  positive: "#15803d",
  /** --color-danger-700 — negative tone. */
  negative: "#b91c1c",
  /** --color-warning-700 — warning tone. */
  warning: "#b45309",
} as const;

/** Dark-mode counterpart for the on-screen preview modal only —
 *  printed output is always light (ink-saving, universally legible). */
export const PRINT_DARK = {
  ink: "#f1f5f9",
  muted: "#94a3b8",
  line: "#334155",
  zebra: "#1e293b",
  band: "#1e293b",
  headText: "#e2e8f0",
  page: "#0b1220",
  sheet: "#0f172a",
} as const;

/**
 * Preview color scheme for print documents (paper is always light).
 * `"system"` follows the OS `prefers-color-scheme`; the modal resolves
 * it to light/dark via matchMedia for its own button state.
 */
export type PrintScheme = "light" | "dark" | "system";
/** What the CSS actually receives after resolving "system". */
export type ResolvedPrintScheme = Exclude<PrintScheme, "system">;

/** CSS custom properties the print engines style against. */
export interface PrintCssVars {
  "--brand": string;
  "--brand-dark": string;
  "--ink": string;
  "--muted": string;
  "--line": string;
  "--band": string;
  "--head-text": string;
  "--totals-bg": string;
  "--page": string;
  "--sheet": string;
}

/** Light palette (printed output). */
export const PRINT_VARS_LIGHT: PrintCssVars = {
  "--brand": PRINT_BRAND.brand,
  "--brand-dark": PRINT_BRAND.brandDark,
  "--ink": PRINT_BRAND.ink,
  "--muted": PRINT_BRAND.muted,
  "--line": PRINT_BRAND.line,
  "--band": PRINT_BRAND.band,
  "--head-text": "#334155",
  "--totals-bg": PRINT_BRAND.ink,
  "--page": "#eef2f6",
  "--sheet": "#ffffff",
};

/** Dark palette (on-screen preview only). */
export const PRINT_VARS_DARK: PrintCssVars = {
  "--brand": PRINT_BRAND.brand,
  "--brand-dark": PRINT_BRAND.brandDark,
  "--ink": PRINT_DARK.ink,
  "--muted": PRINT_DARK.muted,
  "--line": PRINT_DARK.line,
  "--band": PRINT_DARK.band,
  "--head-text": PRINT_DARK.headText,
  "--totals-bg": "#334155",
  "--page": PRINT_DARK.page,
  "--sheet": PRINT_DARK.sheet,
};

/**
 * Shared `:root` var block + scheme overrides + scheme script.
 * Usage inside engines:
 *
 *   :root { ${printCssVars("light")} }
 *   [data-scheme="dark"] { ${printCssVars("dark")} }
 *   <head> prefix: ${PRINT_SCHEME_SCRIPT}
 *
 * Scheme contract:
 * - no attribute      → light (default)
 * - data-scheme=dark  → forced dark
 * - data-scheme=auto  → follows prefers-color-scheme
 */
export function printCssVars(scheme: ResolvedPrintScheme): string {
  const v = scheme === "dark" ? PRINT_VARS_DARK : PRINT_VARS_LIGHT;
  return Object.entries(v)
    .map(([k, val]) => `${k}: ${val};`)
    .join(" ");
}

/** localStorage key shared by the preview modal and this script. */
export const PRINT_SCHEME_STORAGE_KEY = "najjar.print-scheme";

/**
 * Cookie mirror of the scheme choice (written by the preview modal,
 * read as a fallback when localStorage is unavailable — private
 * windows, http:// LAN terminals, partitioned storage). SameSite=Lax,
 * 1-year max-age.
 */
export const PRINT_SCHEME_COOKIE = "najjar-print-scheme";

/**
 * Inline, dependency-free scheme bootstrap (CSP-safe: no eval).
 * Maps the persisted PrintScheme onto the document root BEFORE first
 * paint: "dark" pins dark, "system" pins `auto` (CSS then follows
 * prefers-color-scheme), anything else pins light by removing the
 * attribute. Standalone files (samples, downloads) default to light
 * when nothing is stored.
 */
export const PRINT_SCHEME_SCRIPT =
  `<script>(function(){try{var d=document.documentElement,s=localStorage.getItem(${JSON.stringify(PRINT_SCHEME_STORAGE_KEY)});` +
  `if(s==="dark"){d.setAttribute("data-scheme","dark");}` +
  `else if(s==="system"){d.setAttribute("data-scheme","auto");}` +
  `else{d.removeAttribute("data-scheme");}}catch(e){}})();</script>`;



/* ────────────────────────────────────────────────────────────────
   PAGE-MEASUREMENT + RULER SCRIPT — shared by every print engine
   Embedded once per document (engines import this constant, so the
   two copies can never drift). Preview-only duties:
     1. postMessage the sheet's rendered size + page count
     2. build the page-break ruler (data-preview="1" gated)
     3. jump-to-page messages from the preview modal
     4. click any break marker to scroll to that page
   CSP-safe: attribute/DOM only, no eval. Paper never runs it into
   layout: the ruler is @media print { display:none }.
   ──────────────────────────────────────────────────────────────── */

export const PAGE_MEASURE_SCRIPT =
  `<script>(function(){` +
  `var PAGE_MM=297,MARGIN_MM=24,MM_PER_PX=25.4/96;var ruler=null;` +
  `function usablePx(){return (1/MM_PER_PX)*(PAGE_MM-MARGIN_MM);}` +
  `function sheetTop(){var el=document.querySelector(".sheet");return el?el.getBoundingClientRect().top+window.scrollY:0;}` +
  `function buildRuler(pages){` +
  `if(document.documentElement.getAttribute("data-preview")!=="1")return;` +
  `if(ruler&&ruler.parentNode)ruler.parentNode.removeChild(ruler);` +
  `ruler=document.createElement("div");ruler.className="page-ruler";` +
  `for(var i=1;i<pages;i++){` +
  `var b=document.createElement("div");b.className="page-break";` +
  `b.style.top=(sheetTop()+i*usablePx())+"px";` +
  `b.setAttribute("data-page",String(i+1));b.title="Jump to page "+(i+1);` +
  `b.addEventListener("click",function(ev){var t=ev.currentTarget.getAttribute("data-page");` +
  `window.scrollTo({top:sheetTop()+(parseInt(t,10)-1)*usablePx(),behavior:"smooth"});});` +
  `ruler.appendChild(b);}` +
  `document.body.appendChild(ruler);}` +
  `window.addEventListener("message",function(e){var d=e.data||{};` +
  `if(d.type==="najjar-print-go-page"&&typeof d.page==="number"){` +
  `window.scrollTo({top:sheetTop()+(Math.max(1,d.page)-1)*usablePx(),behavior:"smooth"});}});` +
  `function gotoPage(p){window.scrollTo({top:sheetTop()+(Math.max(1,p)-1)*usablePx(),behavior:"smooth"});}` +
  `window.addEventListener("keydown",function(ev){` +
  `if(document.documentElement.getAttribute("data-preview")!=="1")return;` +
  `var tag=(ev.target&&ev.target.tagName)||"";` +
  `if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT"||(ev.target&&ev.target.isContentEditable))return;` +
  `if(ev.ctrlKey||ev.metaKey||ev.altKey)return;` +
  `var el=document.querySelector(".sheet");if(!el)return;` +
  `var pages=Math.max(1,Math.ceil(el.scrollHeight/usablePx()));` +
  `var y=window.scrollY-sheetTop();var cur=Math.floor(y/usablePx())+1;` +
  `if(y<0)cur=1;` +
  `var t=0;` +
  `if(ev.key==="PageDown"||ev.key==="ArrowRight"&&document.documentElement.dir!=="rtl"||ev.key==="ArrowLeft"&&document.documentElement.dir==="rtl")t=Math.min(pages,cur+1);` +
  `else if(ev.key==="PageUp"||ev.key==="ArrowLeft"&&document.documentElement.dir!=="rtl"||ev.key==="ArrowRight"&&document.documentElement.dir==="rtl")t=Math.max(1,cur-1);` +
  `else if(ev.key==="Home"){t=1;ev.preventDefault();}` +
  `else if(ev.key==="End"){t=pages;ev.preventDefault();}` +
  `if(t>0){ev.preventDefault();gotoPage(t);}},true);` +
  `var run=function(){try{var el=document.querySelector(".sheet");if(!el)return;` +
  `var pages=Math.max(1,Math.ceil(el.scrollHeight/usablePx()));` +
  `buildRuler(pages);` +
  `parent.postMessage({type:"najjar-print-page-info",contentHeight:Math.ceil(el.scrollHeight),contentWidth:Math.ceil(el.scrollWidth),pageCount:pages},"*");}catch(e){}};` +
  `var lastSent=-1;` +
  `window.addEventListener("scroll",function(){` +
  `if(document.documentElement.getAttribute("data-preview")!=="1")return;` +
  `if(lastSent&&Math.abs(window.scrollY-lastSent)<40)return;lastSent=window.scrollY;` +
  `var el=document.querySelector(".sheet");if(!el)return;` +
  `var y=window.scrollY-sheetTop();var p=Math.max(1,Math.floor(y/usablePx())+1);` +
  `parent.postMessage({type:"najjar-print-scroll",page:p},"*");},{passive:true});` +
  `if(document.readyState!=="loading"){run();}else{document.addEventListener("DOMContentLoaded",run);} ` +
  `window.addEventListener("load",run);})();</script>`;

/* ────────────────────────────────────────────────────────────────
   PAGE-RULER CSS — shared by every print engine (same guarantee as
   PAGE_MEASURE_SCRIPT: one declaration, imported, so the engines'
   documents can never drift). Preview-only chrome:
     - dashed brand-blue break line + page chip per sheet boundary
     - 16px hit area, hover fill, click-to-jump (wired by the script)
     - display:none on paper via @media print
   ──────────────────────────────────────────────────────────────── */

export const PRINT_RULER_CSS =
  `/* Page-break ruler — preview-only chrome, never printed, only
     mounted when the preview modal opts in via data-preview="1".
     Markers are click-to-jump: hit area + hover affordance. */
  .page-ruler { position: absolute; inset: 0; pointer-events: none; }
  .page-ruler .page-break {
    position: absolute; left: 0; right: 0; height: 0;
    border-top: 1px dashed ${PRINT_BRAND.brand};
  }
  .page-ruler .page-break::before {
    content: ""; position: absolute; left: 0; right: 0; top: -8px; height: 16px;
    pointer-events: auto; cursor: pointer;
  }
  .page-ruler .page-break::after {
    content: attr(data-page);
    position: absolute; right: 8px; top: -9px;
    font-size: 8px; font-weight: 700; letter-spacing: 0.6px;
    color: ${PRINT_BRAND.brand}; background: var(--sheet);
    border: 1px solid ${PRINT_BRAND.brand}; border-radius: 999px;
    padding: 0 6px; transition: background 120ms, color 120ms;
  }
  .page-ruler .page-break:hover::after {
    background: ${PRINT_BRAND.brand}; color: #fff;
  }
  @media print { .page-ruler { display: none !important; } }`;
