#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Codemod: legacy page-markup utilities → neu tokens.

   WHY a token-level swap and not a redesign: the shared page *classes*
   are already neu (see docs/DESIGN-NEUMORPHISM.md "Page surfaces"), but
   the bespoke per-page JSX still composed `bg-white` / `text-surface-400`
   / `border-surface-200` / `dark:bg-surface-100` and the legacy
   `focus:ring-brand-500/20` cluster. This migrates the COLOUR and FOCUS
   vocabulary only — geometry (heights, padding, radii, grid) is left
   exactly as-is, so dense in-page controls keep their layout instead of
   being forced into the 48px `.neu-input` shape.

   Rules, in order, per class string:
     0. a `hover:X` whose bare `X` is already on the element (and whose
        axis has no `dark:` variant to keep the two states apart) is DEAD
        — it can never paint — so it is dropped. Rule 1 makes these:
        `border-surface-200 hover:border-surface-300` migrates to
        `border-neu-hairline hover:border-neu-hairline`.
     1. fill / ink / border / divide / ring surface tokens → the neu
        equivalents (`bg-neu-bg`, `text-neu-muted`, `border-neu-hairline`,
        `bg-neu-sunken`, …). Variant prefixes (`hover:`, `placeholder:`,
        `group-hover:`, `md:`) and `/opacity` suffixes are preserved.
     2. a `dark:<axis>-surface-*` token is DROPPED when that axis already
        has a mode-aware bare token (the neu token carries both modes) —
        and otherwise converted to the neu token, because a `dark:`
        override is still the right tool when the light colour is a
        non-neu palette hue (e.g. `bg-amber-100 dark:bg-neu-sunken`).
     3. the legacy focus indicator cluster (`focus:outline-none`,
        `focus:ring-2`, `focus:ring-brand-500/20`, `focus:border-brand-500`,
        `focus-visible:ring-offset-2`, …) collapses to the single
        `.neu-focus` class. Affordances that merely change opacity or
        background on focus are deliberately NOT touched.

   Authoritative validation, same as codemod-dialog-body.mjs: the result
   is re-parsed with the TypeScript compiler API, and the file is left
   byte-identical if it fails to parse.

   Tokens with no safe mechanical mapping (gradient stops `from-/to-`,
   `bg-surface-800/900`, `shadow-surface-*`, and the remaining brand
   accents) are REPORTED, never guessed at.

   Usage:
     node scripts/codemod-neu-markup.mjs            # dry run + report
     node scripts/codemod-neu-markup.mjs --write    # apply
   ═══════════════════════════════════════════════════════════════ */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import ts from "typescript";

const WRITE = process.argv.includes("--write");
const ROOT = "src";
/* This checkout has no git, so the pre-image of every rewritten file is
   kept (same convention as .codemod-backup/). NEU_BACKUP_SUFFIX lets a
   later pass keep its OWN pre-images instead of clobbering the originals
   `--reapply` needs as its oracle. */
const BACKUP = ".codemod-backup/neu-markup" + (process.env.NEU_BACKUP_SUFFIX || "");

/* Print surfaces stay pure white/#000 for scanner legibility — the
   documented "paper" exception. Never colour-migrate them. */
const EXCLUDE = [
  "src/components/products/barcode-label.tsx",
  "src/components/print/print-preview.tsx",
];

/* ── 1. surface token → neu token ── */
const SURFACE_TOKEN =
  /^(?:[a-z0-9-]+:)*(bg-white|bg-surface-\d+|text-surface-\d+|border-surface-\d+|divide-surface-\d+|ring-surface-\d+)(\/\d+)?$/;

const NEU_MAP = {
  "bg-white": "bg-neu-bg",
  "bg-surface-50": "bg-neu-sunken",
  "bg-surface-100": "bg-neu-sunken",
  "bg-surface-200": "bg-neu-sunken",
  "bg-surface-300": "bg-neu-sunken",

  "text-surface-50": "text-neu-muted",
  "text-surface-100": "text-neu-muted",
  "text-surface-200": "text-neu-muted",
  // The legacy ladder's faint tiers (surface-300/400/500 = #cbd5e1/#94a3b8/
  // #64748b, all below AA as text) become `faint`; surface-600 is exactly
  // `--neu-text-muted`. See the `--faint` mode below for how the sites
  // already migrated before this token existed are corrected.
  "text-surface-300": "text-neu-faint",
  "text-surface-400": "text-neu-faint",
  "text-surface-500": "text-neu-faint",
  "text-surface-600": "text-neu-muted",
  "text-surface-700": "text-neu-primary",
  "text-surface-800": "text-neu-primary",
  "text-surface-900": "text-neu-primary",
  "text-surface-950": "text-neu-primary",

  "border-surface-50": "border-neu-hairline",
  "border-surface-100": "border-neu-hairline",
  "border-surface-200": "border-neu-hairline",
  "border-surface-300": "border-neu-hairline",

  "divide-surface-100": "divide-neu-hairline",
  "divide-surface-200": "divide-neu-hairline",
  "divide-surface-300": "divide-neu-hairline",

  "ring-surface-100": "ring-neu-hairline",
  "ring-surface-200": "ring-neu-hairline",
  "ring-surface-300": "ring-neu-hairline",
};

/* ── 1b. brand accent → neu accent ──
   The legacy blue palette migrates onto the neu interactive cyan. The rule
   is SUFFIX-AWARE, because the same `bg-brand-N` means two different things:
     · opaque       → a solid fill that carries white ink → mode-STABLE
     · `/opacity`   → a tint / heat step that must follow the surface →
                      mode-AWARE, so its `dark:` twin becomes redundant
   brand-50/100 are washes at ANY opacity (a 60% brand-50 is still a pale
   wash), and every border/ring/gradient stop is an edge or a tint, so those
   take the AA 3:1 `line` cyan rather than a fill. */
const BRAND_TOKEN =
  /^(?:[a-z0-9-]+:)*(bg|text|border|divide|ring|from|via|to|shadow|accent)-brand-(\d+)(\/\d+)?$/;

const brandMap = (axis, step, opacity) => {
  switch (axis) {
    case "text":
      return step >= 700 ? "text-neu-accent-ink-strong" : "text-neu-accent-ink";
    case "bg":
      if (step <= 100) return "bg-neu-accent-wash" + (opacity ?? "");
      if (opacity) return "bg-neu-accent-line" + opacity;
      return step >= 700 ? "bg-neu-accent-solid-strong" : "bg-neu-accent-solid";
    case "accent":
      return "accent-neu-accent-solid";
    case "shadow":
      return "shadow-neu-accent-line" + (opacity ?? "");
    default:
      // border / divide / ring / from / via / to — every one is an edge or
      // a gradient stop, i.e. decoration that still has to clear 3:1.
      return axis + "-neu-accent-line" + (opacity ?? "");
  }
};

/* ── 1c. semantic status palette → neu status roles ──
   `success | warning | danger | info` is the last legacy vocabulary that
   carries MEANING rather than surface. Each maps onto the neu role for its
   hue: success→green, warning→amber, danger→red, info→cyan.

   SUFFIX-AWARE again, because the same `-500` means different things on
   different axes:
     text-*-N                → the AA status ink
     bg-*-N      (N <= 300)  → the mode-aware wash
     bg-*-N      (N >= 400)  → the mode-STABLE solid fill (white ink on it)
     bg-*-N/α    (α  < 50)   → a tint, so the wash
     accent-*                → the solid fill (a form control's own colour)
     shadow-*                → the solid fill (a glow under a solid pill)
     border/ring/divide-*-N  → the ink at the edge (it must clear 3:1); the
                               genuinely pale steps keep a soft alpha so a
                               decorative hairline stays quiet

   GRADIENTS (`from`/`via`/`to`) are deliberately NOT mapped: a two-stop
   ramp needs a lighter and a darker role picked per stop, which is
   judgement rather than a rule. They are REPORTED instead, so none is
   forgotten — an unmapped survivor is exactly what this codemod exists to
   prevent. */
const SEMANTIC_TOKEN =
  /^(?:[a-z0-9-]+:)*(bg|text|border|divide|ring|shadow|outline|accent|fill|stroke|from|via|to)-(success|warning|danger|info)-(\d+)(\/\d+)?$/;

const SEMANTIC_HUE = { success: "green", warning: "amber", danger: "red", info: "cyan" };
const SEMANTIC_GRADIENT = new Set(["from", "via", "to"]);

const semanticMap = (axis, hue, step, opacity) => {
  if (SEMANTIC_GRADIENT.has(axis)) return null;
  const g = SEMANTIC_HUE[hue];
  const alpha = Number((opacity ?? "/100").slice(1));
  switch (axis) {
    // A mark drawn on the surface: the ink is the only legible choice.
    case "text":
    case "fill":
    case "stroke":
      return axis + "-neu-ink-" + g;
    case "bg":
      if (step <= 300 || alpha < 50) return "bg-neu-wash-" + g;
      return "bg-neu-solid-" + g + (opacity ?? "");
    case "accent":
    case "shadow":
      return axis + "-neu-solid-" + g + (opacity ?? "");
    default:
      // border / divide / ring / outline — an edge that has to read 3:1.
      return axis + "-neu-ink-" + g + (step <= 300 ? (opacity ?? "/35") : (opacity ?? ""));
  }
};

/* Tokens we recognise as legacy but refuse to map mechanically. The brand
   and semantic catch-alls cover the axes their own token regexes do NOT
   (e.g. the directional `border-t-brand-600`, or a gradient stop) — those
   must be REPORTED, because a silent survivor is exactly what this codemod
   exists to prevent. */
const DEFERRED =
  /^(?:[a-z0-9-]+:)*(from|to|via)-surface-\d+$|^(?:[a-z0-9-]+:)*bg-surface-(?:800|900|950)$|^(?:[a-z0-9-]+:)*shadow-surface-\d+$|^(?:[a-z0-9-]+:)*[a-z-]+-brand-\d+(?:\/\d+)?$|^(?:[a-z0-9-]+:)*(?:bg|text|border|divide|ring|shadow|outline|accent|fill|stroke|from|via|to)-(?:success|warning|danger|info)-\d+(?:\/\d+)?$/;

/* ── 3. legacy focus indicator cluster ── */
const FOCUS_BASE =
  /^(?:outline-none|outline-\[\d+px\]|ring-\d+|ring-offset-\d+|ring-(?:brand|danger|surface)-\d+(?:\/\d+)?|border-(?:brand|danger)-\d+)$/;

const isLegacyFocus = (tok) => {
  const parts = tok.split(":");
  if (parts.length < 2) return false;
  const variants = parts.slice(0, -1);
  if (!variants.includes("focus") && !variants.includes("focus-visible")) return false;
  return FOCUS_BASE.test(parts[parts.length - 1]);
};

/** The property a utility sets: `group-hover:bg-neu-sunken` → `bg`. */
const axisOf = (tok) => {
  const base = tok.split(":").pop();
  return base.split("-")[0];
};

/* Only the tokens whose VALUE re-points under `.dark` count as
   mode-aware. `bg-neu-scrim` and `bg-neu-solid-ink` are deliberately
   mode-STABLE, so a `dark:` override next to them is still meaningful and
   must be kept — otherwise re-running this codemod would delete it. */
/* The trailing `(?:\/\d+)?` matters: `bg-surface-50 dark:bg-surface-200/40`
   converts the dark half to `dark:bg-neu-sunken/40`, and unless that counts
   as mode-aware the redundant override survives the drop (regressing
   idempotency between passes). */
const MODE_AWARE = new RegExp(
  "^(?:[a-z0-9-]+:)*(?:" +
    "bg-neu-(?:bg|sunken|accent-line|accent-wash|wash-(?:cyan|green|amber|red))" +
    "|text-neu-(?:primary|muted|faint|accent-ink|accent-ink-strong|ink-(?:cyan|green|amber|red))" +
    "|(?:border|divide|ring|outline|fill|stroke)-neu-(?:hairline|accent-line|ink-(?:cyan|green|amber|red))" +
    "|(?:from|via|to)-neu-accent-line" +
  ")(?:\\/\\d+)?$"
);

/* ── transform one class string ── */
function transformClasses(value, report) {
  const tokens = value.split(/(\s+)/); // keep whitespace as tokens
  const words = tokens.filter((t) => t.trim() !== "");

  const converted = words.map((tok) => {
    const m = tok.match(SURFACE_TOKEN);
    if (!m) {
      const b = tok.match(BRAND_TOKEN);
      if (b) {
        const [, axis, step, opacity] = b;
        return tok.slice(0, tok.indexOf(axis + "-brand-")) + brandMap(axis, Number(step), opacity);
      }
      const s = tok.match(SEMANTIC_TOKEN);
      if (s) {
        const [, axis, hue, step, opacity] = s;
        const mapped = semanticMap(axis, hue, Number(step), opacity);
        if (mapped) return tok.slice(0, tok.indexOf(axis + "-" + hue + "-")) + mapped;
        report.deferred.push(tok);
        return tok;
      }
      if (DEFERRED.test(tok)) report.deferred.push(tok);
      return tok;
    }
    const base = m[1];
    const suffix = m[2] ?? "";
    const mapped = NEU_MAP[base];
    if (!mapped) {
      report.deferred.push(tok);
      return tok;
    }
    const prefix = tok.slice(0, tok.length - base.length - suffix.length);
    return prefix + mapped + suffix;
  });

  // 2. drop dark overrides whose axis is already mode-aware.
  const modeAwareAxes = new Set(
    converted.filter((t) => !t.startsWith("dark:") && MODE_AWARE.test(t)).map(axisOf)
  );
  let out = converted.filter((tok) => {
    if (!tok.startsWith("dark:")) return true;
    if (!SURFACE_TOKEN.test(tok.slice(5)) && !MODE_AWARE.test(tok)) return true;
    return !modeAwareAxes.has(axisOf(tok.slice(5)));
  });

  // 3. collapse the legacy focus cluster into `.neu-focus`.
  const focusHits = out.filter(isLegacyFocus);
  if (focusHits.length) {
    out = out.filter((t) => !isLegacyFocus(t));
    if (!out.includes("neu-focus")) out.push("neu-focus");
    report.focus += focusHits.length;
  }

  // 4. drop a `hover:X` that can never paint because the element already
  //    carries `X`. Only when no `dark:` token shares the axis — otherwise
  //    the two modes genuinely resolve differently and the hover matters.
  const deadHover = out.filter((t) => {
    if (!t.startsWith("hover:")) return false;
    const base = t.slice("hover:".length);
    if (!out.includes(base)) return false;
    const axis = axisOf(base);
    return !out.some((u) => u.startsWith("dark:") && axisOf(u.slice("dark:".length)) === axis);
  });
  if (deadHover.length) {
    out = out.filter((t) => !deadHover.includes(t));
    report.deadHover = (report.deadHover ?? 0) + deadHover.length;
  }

  if (out.length === words.length && out.every((t, i) => t === words[i])) return value;

  // Re-join preserving the original whitespace runs.
  const ws = tokens.filter((t) => t.trim() === "");
  let result = out[0] ?? "";
  for (let i = 1; i < out.length; i++) result += (ws[i - 1] ?? " ") + out[i];
  return result;
}

/** Collect class-ish string literals, right-to-left, with exact spans. */
function classSpans(sf) {
  const spans = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sf) + 1;
      const end = node.getEnd() - 1;
      spans.push({ start, end, value: sf.text.slice(start, end) });
    } else if (ts.isTemplateExpression(node)) {
      // `${}` makes the content non-contiguous, so flag (rather than risk
      // corrupting) only the templates whose STATIC text looks like it
      // carries a legacy surface class.
      const statics = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
      if (/surface-\d|\bbg-white\b/.test(statics)) spans.template = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return spans.sort((a, b) => b.start - a.start);
}

const parses = (text) =>
  ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    .parseDiagnostics.length === 0;

/** Every .ts/.tsx under src/, minus the print exceptions. */
function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => `${e.parentPath.replace(/\\/g, "/")}/${e.name}`)
    .filter((f) => !EXCLUDE.includes(f))
    .sort();
}

/* ═══════════════════════════════════════════════════════════════
   Mode: --reapply

   Re-syncs the tree with the CURRENT NEU_MAP after the table itself has
   changed — without ever clobbering a hand-edit.

   Why it is needed: the first pass collapsed the legacy grey ladder
   surface-300/400/500 onto a single `text-neu-muted`, because the neu
   system shipped only two inks at the time. Once `--neu-text-faint`
   existed, that had to be undone — but the information was gone from the
   migrated files. The pre-images in .codemod-backup/ are the only oracle.

   How it aligns without byte offsets: the number and DOCUMENT ORDER of
   class strings never changed (neither pass adds or removes a string
   literal, and the hand-edits were in-place), so the Nth span in the
   pre-image pairs with the Nth span in the working file. A span is only
   rewritten when the working value is EXACTLY what the current map
   produces from the pre-image, up to a faint/muted difference — so a span
   a human has since edited is reported, never overwritten.
   ═══════════════════════════════════════════════════════════════ */
if (process.argv.includes("--reapply")) {
  /** `text-neu-faint` is the only token this mode may newly introduce. */
  const undoFaint = (v) => v.replace(/\btext-neu-faint\b/g, "text-neu-muted");

  let files = 0, spans = 0;
  const handEdited = [], unpaired = [];

  for (const file of walk(ROOT)) {
    const backupPath = `${BACKUP}/${file}`;
    if (!existsSync(backupPath)) continue;

    const current = readFileSync(file, "utf8");
    const backupText = readFileSync(backupPath, "utf8");
    const spanOf = (text) =>
      classSpans(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
    const before = spanOf(backupText).sort((a, b) => a.start - b.start);
    const now = spanOf(current).sort((a, b) => a.start - b.start);

    if (before.length !== now.length) {
      unpaired.push(`${file} (${before.length} -> ${now.length} class strings)`);
      continue;
    }

    const edits = [];
    for (let i = 0; i < before.length; i++) {
      const wanted = transformClasses(before[i].value, { deferred: [], focus: 0 });
      if (undoFaint(wanted) === now[i].value) {
        if (wanted !== now[i].value) edits.push({ ...now[i], value: wanted });
      } else if (wanted !== now[i].value) {
        // Diverges by more than faint/muted: assume a human has been here.
        handEdited.push(`${file} (span ${i + 1})`);
      }
    }
    if (!edits.length) continue;

    let out = current;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.value + out.slice(e.end);
    }
    if (!parses(out)) {
      console.log(`\u2717 ${file}: result failed to parse \u2014 file LEFT UNCHANGED`);
      continue;
    }
    if (WRITE) {
      mkdirSync(dirname(`${BACKUP}-pre-reapply/${file}`), { recursive: true });
      copyFileSync(file, `${BACKUP}-pre-reapply/${file}`);
      writeFileSync(file, out);
    }
    files++;
    spans += edits.length;
    console.log(`\u00b7 ${file}: ${edits.length} class string(s) re-synced`);
  }

  console.log(`\n${WRITE ? "Re-synced" : "Would re-sync"} ${spans} class string(s) in ${files} file(s).`);
  if (unpaired.length) console.log(`\n\u26a0 span count drifted \u2014 skipped:\n   ${unpaired.join("\n   ")}`);
  if (handEdited.length) console.log(`\n\u26a0 hand-edited since the first pass (left alone):\n   ${handEdited.join("\n   ")}`);
  process.exit(0);
}

let touched = 0;
let totalTokens = 0;
const deferredAll = [];
const templateFiles = [];

for (const file of walk(ROOT)) {
  const original = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const spans = classSpans(sf);
  if (spans.template) templateFiles.push(file);

  const report = { deferred: [], focus: 0, deadHover: 0 };
  const edits = [];
  for (const span of spans) {
    const next = transformClasses(span.value, report);
    if (next !== span.value) edits.push({ ...span, next });
  }

  if (report.deferred.length) {
    deferredAll.push({
      file,
      tokens: [...new Set(report.deferred)],
      lines: report.deferred.map((t) => {
        const i = original.indexOf(t);
        return i === -1 ? "?" : sf.getLineAndCharacterOfPosition(i).line + 1;
      }),
    });
  }
  if (!edits.length) continue;

  let out = original;
  for (const e of edits) out = out.slice(0, e.start) + e.next + out.slice(e.end);

  if (!parses(out)) {
    console.log(`✗ ${file}: result failed to parse — file LEFT UNCHANGED (${edits.length} span(s))`);
    continue;
  }

  const tokenDelta = edits.reduce((n, e) => n + e.next.split(/\s+/).length - e.value.split(/\s+/).length, 0);
  totalTokens += edits.length;
  touched++;
  if (WRITE) {
    mkdirSync(dirname(`${BACKUP}/${file}`), { recursive: true });
    copyFileSync(file, `${BACKUP}/${file}`);
    writeFileSync(file, out);
  }
  console.log(
    `${WRITE ? "✔" : "·"} ${file}: ${edits.length} class string(s)` +
    (report.focus ? `, ${report.focus} focus token(s)` : "") +
    (report.deadHover ? `, ${report.deadHover} dead hover token(s)` : "") +
    (tokenDelta ? ` (${tokenDelta > 0 ? "+" : ""}${tokenDelta} tokens)` : "")
  );
}

console.log(`\n${WRITE ? "Applied to" : "Would change"} ${touched} file(s), ${totalTokens} class string(s).`);

if (templateFiles.length) {
  console.log(`\n⚠ ${templateFiles.length} file(s) contain a template-literal class expression (not auto-edited):`);
  for (const f of templateFiles) console.log(`   ${f}`);
}

if (deferredAll.length) {
  console.log(`\n⚠ Recognised-but-unmapped legacy tokens (handle by hand):\n`);
  for (const d of deferredAll) {
    console.log(`   ${d.file}:${d.lines.join(",")}  ${d.tokens.join(" ")}`);
  }
}
