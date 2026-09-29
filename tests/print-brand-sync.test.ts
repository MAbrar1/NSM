import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRINT_BRAND, PRINT_DARK, printCssVars, PRINT_SCHEME_SCRIPT, PRINT_SCHEME_STORAGE_KEY } from "../src/lib/print-brand";

/* ═══════════════════════════════════════════════════════════════
   PRINT-BRAND SYNC
   Every printed surface (A4 reports, PO documents, the Excel
   header band) must read as the same product as the on-screen
   UI. These tests parse src/app/globals.css and fail if the
   frozen palettes in print-brand.ts or the hex in csv.ts drift
   from the @theme tokens.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Parse the palette out of globals.css (test-side mirror of the tokens).
 * Only the FIRST occurrence of each name is read — the file later
 * redefines several of them inside `.dark`, and paper/the light palette is
 * what this test is about. Both the legacy `--color-*` scale and the neu
 * accent tokens are collected, and `var()` aliases are followed, because
 * the accent tokens are deliberately built out of each other
 * (`--neu-accent-solid: var(--neu-solid-cyan)`).
 */
function tokensFromGlobalsCss(): Record<string, string> {
  // Comments must go FIRST: globals.css documents the tokens inside them
  // ("Measured on --neu-bg: ink 6.10:1 …"), and a `--token:` inside a
  // comment otherwise swallows the next real declaration up to its `;`.
  const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+):\s*([^;{}]+);/gi)) {
    const name = m[1]!;
    if (!declared.has(name)) declared.set(name, m[2]!.trim());
  }
  const resolve = (name: string, depth = 0): string | undefined => {
    const value = declared.get(name);
    if (!value) return undefined;
    const alias = value.match(/^var\((--[a-z0-9-]+)\)$/i);
    if (alias && depth < 4) return resolve(alias[1]!, depth + 1);
    return value.toLowerCase();
  };

  const tokens: Record<string, string> = {};
  for (const [name, value] of declared) {
    const legacy = name.match(/^--color-(brand|surface|success|danger|warning)-(\d+)$/);
    if (legacy) {
      tokens[`${legacy[1]}-${legacy[2]}`] = value.toLowerCase();
      continue;
    }
    const neu = name.match(/^--neu-(accent-ink|accent-ink-strong|accent-tint|accent-solid|solid-cyan|focus-ring)$/);
    if (neu) tokens[`neu-${neu[1]}`] = (resolve(name) ?? value).toLowerCase();
  }
  return tokens;
}

describe("print brand sync", () => {
  const tokens = tokensFromGlobalsCss();

  it("globals.css defines the tokens the palette mirrors", () => {
    for (const key of ["surface-900", "surface-500", "surface-200", "surface-50", "surface-100", "success-700", "danger-700", "warning-700"]) {
      assert.ok(tokens[key], `globals.css must define --color-${key}`);
    }
    for (const key of ["neu-accent-ink", "neu-accent-ink-strong", "neu-accent-tint", "neu-accent-solid"]) {
      assert.ok(tokens[key], `globals.css must define --${key}`);
    }
  });

  it("the legacy blue brand palette is gone from globals.css", () => {
    const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
    assert.doesNotMatch(css, /--color-brand-\d+:/, "the migrated accent palette must not come back");
  });

  it("PRINT_BRAND accents mirror the neu accent tokens", () => {
    assert.equal(PRINT_BRAND.brand, tokens["neu-accent-ink"]);
    assert.equal(PRINT_BRAND.brandDark, tokens["neu-accent-ink-strong"]);
    assert.equal(PRINT_BRAND.brandTint, tokens["neu-accent-tint"]);
  });

  it("PRINT_BRAND neutrals mirror the surface/status scale", () => {
    assert.equal(PRINT_BRAND.ink, tokens["surface-900"]);
    assert.equal(PRINT_BRAND.muted, tokens["surface-500"]);
    assert.equal(PRINT_BRAND.line, tokens["surface-200"]);
    assert.equal(PRINT_BRAND.zebra, tokens["surface-50"]);
    assert.equal(PRINT_BRAND.band, tokens["surface-100"]);
    assert.equal(PRINT_BRAND.positive, tokens["success-700"]);
    assert.equal(PRINT_BRAND.negative, tokens["danger-700"]);
    assert.equal(PRINT_BRAND.warning, tokens["warning-700"]);
  });

  it("print accents are chosen for PAPER (>= 4.5:1 on white)", () => {
    // #0891b2 (--neu-accent-line) is the screen edge colour and only
    // reaches 3.6:1 on paper — print must use the darker ink step.
    const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (hex: string) => {
      const n = parseInt(hex.replace("#", ""), 16);
      return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    };
    const onWhite = (hex: string) => (1.05) / (lum(hex) + 0.05);
    assert.ok(onWhite(PRINT_BRAND.brand) >= 4.5, `brand ${PRINT_BRAND.brand} must clear 4.5:1 on white`);
    assert.ok(onWhite(PRINT_BRAND.brandDark) >= 4.5, `brandDark ${PRINT_BRAND.brandDark} must clear 4.5:1 on white`);
  });

  it("csv.ts Excel header band uses --neu-accent-solid", () => {
    const csv = readFileSync(join(process.cwd(), "src", "lib", "csv.ts"), "utf8");
    const m = csv.match(/const BAND_HEX = "([0-9A-Fa-f]{6})"/);
    assert.ok(m, "csv.ts must declare BAND_HEX");
    assert.equal(`#${m[1]!.toLowerCase()}`, tokens["neu-accent-solid"]);
  });

  it("print-report.ts contains no stale teal brand hexes", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "print-report.ts"), "utf8");
    assert.doesNotMatch(src, /#0f766e|#115e59/i, "stale teal palette crept back into print-report");
  });

  it("print-purchase-order.ts contains no stale teal brand hexes", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "print-purchase-order.ts"), "utf8");
    assert.doesNotMatch(src, /#0f766e|#115e59/i, "stale teal palette crept back into print-purchase-order");
  });

  it("printCssVars emits every documented var for both schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      const vars = printCssVars(scheme);
      for (const name of ["--brand", "--brand-dark", "--ink", "--muted", "--line", "--band", "--head-text", "--totals-bg", "--page", "--sheet"]) {
        assert.match(vars, new RegExp(`${name}:\\s*#[0-9a-fA-F]{6};`), `${scheme} scheme must define ${name}`);
      }
    }
    // schemes must actually differ outside the brand accents
    assert.notEqual(printCssVars("light"), printCssVars("dark"));
    assert.ok(printCssVars("dark").includes(PRINT_DARK.ink));
  });

  it("print engines declare the dark-scheme override and print-light guard", () => {
    for (const file of ["print-report.ts", "print-purchase-order.ts"]) {
      const src = readFileSync(join(process.cwd(), "src", "lib", file), "utf8");
      assert.ok(src.includes('[data-scheme="dark"]'), `${file} must style the dark scheme`);
      assert.ok(src.includes("@media print"), `${file} must keep a @media print guard`);
      assert.match(src, /printCssVars\("light"\)/, `${file} must re-assert the light palette for paper`);
      assert.ok(src.includes("printCssVars("), `${file} must source vars from print-brand`);
    }
  });

  it("scheme bootstrap maps light/dark/system onto data-scheme", () => {
    assert.ok(PRINT_SCHEME_SCRIPT.includes(JSON.stringify(PRINT_SCHEME_STORAGE_KEY)));
    // dark → pinned dark attribute
    assert.ok(PRINT_SCHEME_SCRIPT.includes('s==="dark"'), "bootstrap must pin dark");
    // system → auto attribute (media query resolves it)
    assert.ok(PRINT_SCHEME_SCRIPT.includes('s==="system"'), "bootstrap must map system to auto");
    // light/default → attribute removed so CSS falls back to :root
    assert.ok(PRINT_SCHEME_SCRIPT.includes("removeAttribute"), "bootstrap must fall back to light");
    // CSP-safe: inline script only sets an attribute, no eval/new Function
    assert.doesNotMatch(PRINT_SCHEME_SCRIPT, /\beval\b|new Function/);
  });

  it("print engines resolve the system scheme via prefers-color-scheme", () => {
    for (const file of ["print-report.ts", "print-purchase-order.ts"]) {
      const src = readFileSync(join(process.cwd(), "src", "lib", file), "utf8");
      assert.match(src, /@media \(prefers-color-scheme: dark\)/, `${file} must resolve system preference`);
      assert.match(src, /\[data-scheme="auto"\]/, `${file} must style the auto (system) state`);
      // the print guard must force light for every scheme state
      assert.match(src, /:root, \[data-scheme="dark"\], \[data-scheme="auto"\]/, `${file} must force light paper for all schemes`);
    }
  });

  it("print engines embed the page-measurement handshake", () => {
    const brand = readFileSync(join(process.cwd(), "src", "lib", "print-brand.ts"), "utf8");
    // single source: the script lives in print-brand, engines only reference it
    const decl = brand.match(/export const PAGE_MEASURE_SCRIPT/g) ?? [];
    assert.equal(decl.length, 1, "PAGE_MEASURE_SCRIPT must be declared exactly once (print-brand)");
    const rulerDecl = brand.match(/export const PRINT_RULER_CSS/g) ?? [];
    assert.equal(rulerDecl.length, 1, "PRINT_RULER_CSS must be declared exactly once (print-brand)");
    for (const file of ["print-report.ts", "print-purchase-order.ts"]) {
      const src = readFileSync(join(process.cwd(), "src", "lib", file), "utf8");
      assert.ok(src.includes("PAGE_MEASURE_SCRIPT"), `${file} must embed the shared measurement script`);
      assert.doesNotMatch(src, /const PAGE_MEASURE_SCRIPT/, `${file} must not redeclare a local copy`);
      assert.ok(src.includes("PRINT_RULER_CSS"), `${file} must interpolate the shared ruler CSS`);
      assert.doesNotMatch(src, /\.page-ruler \{/, `${file} must not carry a local ruler CSS copy`);
    }
    // the shared script implements the full handshake
    assert.match(brand, /najjar-print-page-info/, "script must postMessage the page info");
    assert.match(brand, /najjar-print-go-page/, "script must implement scroll-to-page");
    assert.match(brand, /scrollHeight/, "script must measure the rendered sheet");
    assert.match(brand, /addEventListener\("click"/, "script must wire click-to-jump markers");
    assert.match(brand, /addEventListener\("keydown"/, "script must wire keyboard paging inside the iframe");
    assert.match(brand, /najjar-print-scroll/, "script must broadcast scroll position");
    assert.match(brand, /dir==="rtl"/, "arrow keys must be direction-aware");
    assert.match(brand, /data-preview/, "ruler + keys must be gated behind the preview attribute");
    assert.match(brand, /@media print \{ \.page-ruler \{ display: none/, "ruler CSS must hide on paper");
    assert.match(brand, /:hover::after/, "ruler CSS must include the hover affordance");
  });

  it("preview modal wires the three-state control and page estimator", () => {
    const src = readFileSync(join(process.cwd(), "src", "components", "print", "print-preview.tsx"), "utf8");
    assert.match(src, /prefers-color-scheme: dark/, "modal must track the OS preference via matchMedia");
    assert.match(src, /najjar-print-page-info/, "modal must consume the measurement handshake");
    assert.match(src, /najjar-print-go-page/, "modal must send jump-to-page commands");
    assert.match(src, /estimatePages/, "modal must keep the px→mm estimate fallback");
    assert.ok(src.includes("data-scheme=\"auto\""), "modal must bake the system state onto the document");
  });

  it("scheme choice mirrors to the cookie fallback", () => {
    const brand = readFileSync(join(process.cwd(), "src", "lib", "print-brand.ts"), "utf8");
    assert.match(brand, /PRINT_SCHEME_COOKIE = "najjar-print-scheme"/, "cookie name must be a shared constant");
    const modal = readFileSync(join(process.cwd(), "src", "components", "print", "print-preview.tsx"), "utf8");
    assert.match(modal, /document\.cookie = `\$\{PRINT_SCHEME_COOKIE\}=/, "toggle must write the cookie through");
    assert.match(modal, /samesite=lax/, "cookie must be SameSite=Lax");
    assert.match(modal, /PRINT_SCHEME_COOKIE}=\(light\|dark\|system\)|najjar-print-scheme=\(light\|dark\|system\)/, "modal must read the cookie as a fallback");
  });

  it("downloaded documents never carry the preview chrome attribute", () => {
    const modal = readFileSync(join(process.cwd(), "src", "components", "print", "print-preview.tsx"), "utf8");
    // data-preview is applied only inside buildSrc (iframe encoding),
    // and downloadHtmlFile must keep writing the RAW html.
    const dl = modal.match(/function downloadHtmlFile[\s\S]*?\n}/)?.[0] ?? "";
    assert.ok(dl.length > 0, "downloadHtmlFile must exist");
    assert.doesNotMatch(dl, /data-preview|withPreviewChrome/, "downloads must not bake preview chrome");
    assert.match(dl, /new Blob\(\[html\]/, "downloads must use the raw document html");
  });

  it("preview modal persists the scheme and bakes it into documents", () => {
    const src = readFileSync(join(process.cwd(), "src", "components", "print", "print-preview.tsx"), "utf8");
    assert.ok(src.includes("PRINT_SCHEME_STORAGE_KEY"), "modal must read/write the shared storage key");
    assert.match(src, /localStorage\.setItem\(PRINT_SCHEME_STORAGE_KEY/, "toggle choice must persist");
    assert.match(src, /data-scheme/, "modal must bake the scheme onto the document root");
  });
});
