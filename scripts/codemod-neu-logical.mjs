#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Codemod: physical direction utilities → logical ones.

   WHY: the app ships Urdu, and `I18nProvider` flips
   `document.documentElement.dir` to `rtl`. A physical utility then stops
   meaning what it says — `ml-2` is still LEFT in RTL, so a row of
   controls reverses its own spacing, `left-0` pins a panel to the wrong
   edge, and `text-left` fights the paragraph direction. The shell was
   migrated by hand (and is measured in Urdu by audit-neu-pages.mjs);
   this is the same swap for the occurrences inside the pages and
   components, so the fix is reviewable and re-runnable instead of a
   thousand silent edits.

   The mapping:

     ml-*   → ms-*      mr-*   → me-*      (including the negative forms)
     pl-*   → ps-*      pr-*   → pe-*
     left-* → start-*   right-* → end-*
     text-left  → text-start     text-right → text-end
     border-l-* → border-s-*     border-r-* → border-e-*
     rounded-l-* → rounded-s-*   rounded-r-* → rounded-e-*
     rounded-tl/tr/bl/br-* → rounded-ss/se/es/ee-*
     float-left/right → float-start/end

   Variant prefixes survive: `md:ml-4` → `md:ms-4`, `image:mr-1` → `image:me-1`,
   `max-lg:pr-2` → `max-lg:pe-2`.

   Each rule anchors the utility's VALUE (`ml-2`, `ml-auto`, `left-[50%]`,
   `rounded-tr-lg`) rather than a bare prefix. That is what keeps two near
   misses out of the map: the prose `left-handed` is not a spacing value, and
   `rounded-lg` is a radius SIZE — rewriting it to `rounded-sg` would delete
   the radius. `border-radius: 10px` inside a print template survives for the
   same reason.

   KEPT PHYSICAL, by name, with a reason — see KEEP below: a `left-[50%]`
   paired with `-translate-x-[-50%]` is not a direction but a *symmetric*
   centering, and half-translating it would break both scripts.

   NOT touched, deliberately:
     • `translate-x-*` — the drawer's direction is an explicit pair
       (`-translate-x-full rtl:translate-x-full`), and a blind swap would
       break both directions at once;
     • anything inside `style={{ left: … }}` — an inline physical style is
       a JS value, not a class;
     • `space-x-*` / `divide-x-*` — RTL needs `space-x-reverse` or a `gap-*`
       rewrite, and both are judgement calls;
     • `bg-gradient-to-r` — a gradient has no logical form in Tailwind, and
       the wash it paints fades across its own circle, so the circle can move
       with the corner it belongs to without moving the fade;
   Those are REPORTED rather than guessed at.

   Authoritative validation, same as codemod-neu-markup.mjs: the result is
   re-parsed with the TypeScript compiler API and the file is left
   byte-identical if it fails to parse. Print geometry is out of scope (the
   documented paper exception — paper has no reading direction) and pre-images
   go to .codemod-backup/neu-logical/.

   Usage:
     node scripts/codemod-neu-logical.mjs            # dry run + report
     node scripts/codemod-neu-logical.mjs --write    # apply
   ═══════════════════════════════════════════════════════════════ */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import ts from "typescript";

const WRITE = process.argv.includes("--write");
const ROOT = "src";
const BACKUP = ".codemod-backup/neu-logical";

/* Print surfaces keep physical geometry on purpose: a thermal label is laid
   out on paper, and the paper is not mirrored when the UI is. */
const EXCLUDE = [
  "src/components/products/barcode-label.tsx",
  "src/components/print/print-preview.tsx",
];
const EXCLUDE_PREFIX = ["src/lib/print-"];

/* Bound the edit to string literals in these files: everything else in the
   repo is markup, stylesheet or documentation. */
const LEAD = "(^|[\\s\"'`])";
/* `(?:[a-z0-9.[\\]%-]+:)*` swallows `hover:`, `md:`, `group-hover:`, `max-lg:`. */
const VARIANT = "((?:[a-z0-9.[\\]%-]+:)*)";

/* Tailwind's value vocabularies. A value that is not in the list is not the
   utility: `left-handed`, `border-radius`, `rounded-lg` all stay untouched. */
const SPACING = "(?:[\\d.]+|px|auto|full|screen|min|max|fit|\\[[^\\]]+\\])";
const INSET = "(?:[\\d.]+|px|auto|full|\\d+\\/\\d+|\\[[^\\]]+\\])";

const RULES = [
  {
    name: "margin / padding",
    re: new RegExp(LEAD + VARIANT + "(-?)([mp])([lr])-(" + SPACING + ")(?![\\w-])", "g"),
    to: (m, lead, variant, sign, prop, side, value) =>
      `${lead}${variant}${sign}${prop}${side === "l" ? "s" : "e"}-${value}`,
  },
  {
    name: "inset",
    re: new RegExp(LEAD + VARIANT + "(-?)(left|right)-(" + INSET + ")(?![\\w-])", "g"),
    to: (m, lead, variant, sign, side, value) =>
      `${lead}${variant}${sign}${side === "left" ? "start" : "end"}-${value}`,
  },
  {
    name: "text align",
    re: new RegExp(LEAD + VARIANT + "text-(left|right)(?![\\w-])", "g"),
    to: (m, lead, variant, side) => `${lead}${variant}text-${side === "left" ? "start" : "end"}`,
  },
  {
    name: "border side",
    re: new RegExp(LEAD + VARIANT + "border-([lr])(?![a-z])", "g"),
    to: (m, lead, variant, side) => `${lead}${variant}border-${side === "l" ? "s" : "e"}`,
  },
  {
    name: "corner radius",
    re: new RegExp(LEAD + VARIANT + "rounded-(tl|tr|bl|br|l|r)(?![a-z])", "g"),
    to: (m, lead, variant, side) =>
      `${lead}${variant}rounded-${{ tl: "ss", tr: "se", bl: "es", br: "ee", l: "s", r: "e" }[side]}`,
  },
  {
    name: "float",
    re: new RegExp(LEAD + VARIANT + "float-(left|right)(?![\\w-])", "g"),
    to: (m, lead, variant, side) => `${lead}${variant}float-${side === "left" ? "start" : "end"}`,
  },
];

/* A `left-[50%]`/`right-4` inside a class string that also carries a
   `translate-x-*` is not a reading direction: the offset and the transform
   are two halves of one physical gesture (centering), and in RTL the logical
   half would move while the transform stayed — so both would be wrong. The
   whole span keeps its physical inset and is REPORTED instead. */
const CENTERING_PAIR = /-?translate-x-/;

/** Reported, never auto-edited (see the header). */
const DEFERRED = [
  { name: "space-x-*", re: /(^|[\s"'`])(?:[a-z0-9-]+:)*space-x-(?:reverse|\d+)(?![a-z-])/g },
  { name: "divide-x-*", re: /(^|[\s"'`])(?:[a-z0-9-]+:)*divide-x(?:-reverse)?(?![a-z-])/g },
  { name: "inline physical style", re: /style=\{\{[^}]*(?:left|right|marginLeft|marginRight|paddingLeft|paddingRight)\s*:/g },
];

function transformClasses(value, report) {
  const centered = CENTERING_PAIR.test(value);
  if (centered) report.centering.push(value.trim());

  let out = value;
  for (const { name, re, to } of RULES) {
    if (centered && name === "inset") continue;
    out = out.replace(re, to);
  }
  for (const { name, re } of DEFERRED) {
    const hits = value.match(re);
    if (hits) report.deferred.push(`${name} (${[...new Set(hits.map((h) => h.trim()))].join(" ")})`);
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => `${(e.parentPath ?? e.path).replace(/\\/g, "/")}/${e.name}`)
    .filter((f) => !EXCLUDE.includes(f) && !EXCLUDE_PREFIX.some((p) => f.startsWith(p)))
    .sort();
}

/* Every string literal (or template chunk) that carries a physical direction
   utility. `${}` templates are non-contiguous, so they are flagged for a human
   rather than risked. */
function classSpans(sf) {
  const spans = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sf) + 1;
      const end = node.getEnd() - 1;
      const value = sf.text.slice(start, end);
      if (hasPhysical(value)) spans.push({ start, end, value });
    } else if (ts.isTemplateExpression(node)) {
      const statics = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
      if (hasPhysical(statics)) spans.template = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return spans.sort((a, b) => b.start - a.start);
}

/* The detector behind the report and the ratchet in audit-neu-theme.mjs: the
   same families as RULES, and the same VALUE ANCHOR on each of them. The anchor
   is load-bearing in both directions: without it on the margin/padding family,
   `ml-2` matches as the bare prefix `ml-` and the trailing `(?![\w-])` guard
   then vetoes it — so the detector would silently skip every spacing utility in
   the repo, and report a clean sweep while doing nothing. */
const PHYSICAL = new RegExp(
  `(^|[\\s"'\\\`])(?:[a-z0-9.[\\]%-]+:)*(?:-?m[lr]-(?:${SPACING})|-?p[lr]-(?:${SPACING})|-?(?:left|right)-(?:${INSET})|text-(?:left|right)|border-[lr](?![a-z])|rounded-(?:tl|tr|bl|br|l|r)(?![a-z])|float-(?:left|right))(?![\\w-])`
);
const hasPhysical = (value) => PHYSICAL.test(value);

const parses = (text) =>
  ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    .parseDiagnostics.length === 0;

let touched = 0;
let totalSpans = 0;
let totalTokens = 0;
const centeredAll = [];
const deferredAll = [];
const templateFiles = [];

for (const file of walk(ROOT)) {
  const original = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const spans = classSpans(sf);
  if (spans.template) templateFiles.push(file);

  const report = { centering: [], deferred: [] };
  const edits = [];
  for (const span of spans) {
    const next = transformClasses(span.value, report);
    if (next !== span.value) edits.push({ ...span, next });
  }

  if (report.centering.length) centeredAll.push({ file, hits: [...new Set(report.centering)] });
  if (report.deferred.length) deferredAll.push({ file, hits: [...new Set(report.deferred)] });
  if (!edits.length) continue;

  let out = original;
  for (const e of edits) out = out.slice(0, e.start) + e.next + out.slice(e.end);

  if (!parses(out)) {
    console.log(`\u2717 ${file}: result failed to parse \u2014 file LEFT UNCHANGED (${edits.length} span(s))`);
    continue;
  }

  touched++;
  totalSpans += edits.length;
  totalTokens += edits.reduce((n, e) => n + (e.value.match(new RegExp(PHYSICAL.source, "g")) ?? []).length, 0);
  if (WRITE) {
    mkdirSync(dirname(`${BACKUP}/${file}`), { recursive: true });
    copyFileSync(file, `${BACKUP}/${file}`);
    writeFileSync(file, out);
  }
  console.log(`\u00b7 ${file}: ${edits.length} class string(s)`);
}

console.log(
  `\n${WRITE ? "Applied to" : "Would change"} ${touched} file(s), ${totalSpans} class string(s), ${totalTokens} physical token(s).`
);

if (templateFiles.length) {
  console.log(`\n\u26a0 ${templateFiles.length} file(s) contain a template-literal class expression (not auto-edited):`);
  for (const f of templateFiles) console.log(`   ${f}`);
}

if (centeredAll.length) {
  console.log(`\n\u2139 Centering pairs kept physical (a physical transform needs a physical offset):\n`);
  for (const c of centeredAll) console.log(`   ${c.file}  ${c.hits.join(" | ")}`);
}

if (deferredAll.length) {
  console.log(`\n\u26a0 Needs a human decision (never auto-edited):\n`);
  for (const d of deferredAll) console.log(`   ${d.file}  ${d.hits.join(" | ")}`);
}
