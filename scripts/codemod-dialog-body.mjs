#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Codemod (v4): migrate legacy dialog markup → DialogBody/DialogFooter.

   Strategy: mechanical edits + AUTHORITATIVE validation. After each
   per-span transform the whole file is parsed with the TypeScript
   compiler API; if diagnostics appear, the transform is rejected
   (wrap insertion point back-tracked) — no more balance heuristics.

   Footer idiom (REQUIRED signature): flex … justify-end … border-t …
   px-6 py-4. Everything else stays a div.

   The middle region ends at the earliest footer edit, or </DialogContent>.
   Wrap = <DialogBody className="p-0"> (p-0 cancels body padding via
   tailwind-merge, preserving byte-identical spacing).
   ═══════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const FOOTER_DEFAULTS = new Set([
  "flex", "items-center", "justify-end", "gap-2",
  "border-t", "border-surface-200", "px-6", "py-4",
  "bg-surface-50", "dark:bg-surface-200",
]);

const files = process.argv.slice(2);
let totalFooters = 0, totalBodies = 0, touchedFiles = 0;

/** Parse with the TS compiler; true when zero syntax diagnostics. */
function parses(sourceText) {
  const sf = ts.createSourceFile("x.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return sf.parseDiagnostics.length === 0;
}

for (const file of files) {
  const original = readFileSync(file, "utf8");
  let footers = 0, bodies = 0;

  /* ── locate DialogContent spans (depth counting) ── */
  const spans = [];
  {
    const tagRe = /<\/?DialogContent\b/g;
    let m, start = -1, depth = 0;
    while ((m = tagRe.exec(original))) {
      const isClose = m[0].startsWith("</");
      if (!isClose && start === -1) { start = m.index; depth = 1; continue; }
      if (isClose) {
        depth--;
        if (depth === 0) { spans.push([start, original.indexOf(">", m.index) + 1]); start = -1; }
      } else depth++;
    }
  }

  // Work on one evolving buffer; validate after every span transform.
  let out = original;

  for (const [spanStartO, spanEndO] of spans.reverse()) {
    const spanStart = out.length - (original.length - spanStartO); // noop ref
    // Recompute spans against the CURRENT buffer each iteration by
    // matching from the end: simpler — re-find this span's content.
    // Instead of index math we re-scan: find the span whose opening
    // starts with the same 80 chars as the original span.
    const sig = original.slice(spanStartO, spanStartO + 80);
    const pos = out.indexOf(sig);
    if (pos === -1) continue;
    const spanEnd = pos + (spanEndO - spanStartO);
    const seg = out.slice(pos, spanEnd);
    const spanEdits = [];

    /* ── footer divs → DialogFooter ── */
    const footerOpenRe = /<div className="([^"]*border-t[^"]*)">/g;
    let fm;
    const footerRanges = [];
    while ((fm = footerOpenRe.exec(seg))) {
      const cls = fm[1];
      if (!/justify-end/.test(cls)) continue;
      if (!/px-6 py-4/.test(cls)) continue;
      if (/items-baseline|sticky|absolute|fixed/.test(cls)) continue;
      let depth = 1, closeStart = -1, closeEnd = -1;
      const divTagRe = /<\/?div\b/g;
      divTagRe.lastIndex = fm.index + fm[0].length;
      let dm;
      while ((dm = divTagRe.exec(seg))) {
        depth += dm[0].startsWith("</") ? -1 : 1;
        if (depth === 0) { closeStart = dm.index; closeEnd = seg.indexOf(">", dm.index) + 1; break; }
      }
      if (closeStart === -1) continue;
      footerRanges.push({ openStart: fm.index, openEnd: fm.index + fm[0].length, closeStart, closeEnd, cls });
    }

    // Apply footer edits within the span (right to left).
    const spanLocal = [];
    for (const fr of footerRanges.reverse()) {
      const extras = fr.cls.split(/\s+/).filter((c) => c && !FOOTER_DEFAULTS.has(c));
      const openTag = extras.length ? `<DialogFooter className="${extras.join(" ")}">` : `<DialogFooter>`;
      spanLocal.push({ start: pos + fr.openStart, end: pos + fr.openEnd, replacement: openTag });
      spanLocal.push({ start: pos + fr.closeStart, end: pos + fr.closeEnd, replacement: "</DialogFooter>" });
      footers++;
    }

    /* ── wrap middle in DialogBody (validated) ── */
    const headerClose = seg.indexOf("</DialogHeader>");
    if (headerClose !== -1) {
      const insertAt = headerClose + "</DialogHeader>".length;
      let bodyEnd;
      if (footerRanges.length) {
        bodyEnd = Math.min(...footerRanges.map((f) => f.openStart));
      } else {
        const fIdx = seg.search(/<DialogFooter\b/);
        bodyEnd = fIdx !== -1 ? fIdx : seg.lastIndexOf("</DialogContent>");
      }
      if (bodyEnd > insertAt) {
        const middle = seg.slice(insertAt, bodyEnd);
        if (middle.trim() && !middle.trimStart().startsWith("<DialogBody")) {
          const wsMatch = middle.match(/\S/);
          const indent = wsMatch ? (middle.slice(0, wsMatch.index).match(/[ \t]+$/)?.[0] ?? "            ") : "            ";
          const pre = `\n${indent}<DialogBody className="p-0">`;
          const post = `\n${indent}</DialogBody>\n${indent.slice(0, -2)}`;
          // Back-track the wrap start over nested JSX expression parents
          // until the whole file parses. up to 12 attempts.
          let off = 0;
          const MAX_TRIES = 12;
          for (let t = 0; t < MAX_TRIES; t++) {
            const candidate =
              out.slice(0, pos + insertAt + off) + pre +
              middle.replace(/^\s*\n/, "").replace(/\s+$/, "") + post +
              out.slice(pos + bodyEnd + off);
            // Apply footer edits on top of the candidate, then validate.
            let testBuf = candidate;
            const localEdits = spanLocal.map((e) => ({ ...e })).sort((a, b) => b.start - a.start);
            // footer edit offsets shift by off (insert before them)
            const shifted = localEdits.map((e) => ({ ...e, start: e.start + off, end: e.end + off }));
            for (const e of shifted) testBuf = testBuf.slice(0, e.start) + e.replacement + testBuf.slice(e.end);
            if (parses(testBuf)) {
              out = testBuf;
              bodies++;
              break;
            }
            // Move the wrap opening earlier: extend over the previous line.
            const prevNl = out.lastIndexOf("\n", pos + insertAt + off - 1);
            if (prevNl === -1) break;
            off = prevNl - pos - insertAt;
            if (-off > 4000) break; // give up
          }
          if (!bodies || !out.includes("<DialogBody className=\"p-0\">")) { /* fallthrough */ }
        }
      }
    }

    // Apply ONLY footer edits when the wrap didn't materialize (or already did).
    if (spanLocal.length) {
      const applied = spanLocal.sort((a, b) => b.start - a.start);
      let changed = false;
      for (const e of applied) {
        if (out.slice(e.start, e.end).startsWith("<DialogFooter")) continue;
        if (out.slice(e.start, e.start + 12).startsWith("<div classNa")) {
          out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
          changed = true;
        } else if (e.replacement === "</DialogFooter>" && out.slice(e.start, e.start + 6) === "</div>") {
          out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
          changed = true;
        }
      }
    }
  }

  if (out === original) continue;

  if (!parses(out)) {
    console.log(`✗ ${file}: result failed to parse — file LEFT UNCHANGED`);
    continue;
  }

  out = ensureImports(out, ["DialogBody", "DialogFooter"].filter((n) => out.includes(`<${n}`)));
  writeFileSync(file, out);
  touchedFiles++;
  totalFooters += footers;
  totalBodies += bodies;
  console.log(`${file}: ${footers} footer(s), ${bodies} body wrap(s)`);
}

console.log(`\n${touchedFiles} file(s) — ${totalFooters} footers, ${totalBodies} bodies`);

/* ── helpers ── */

function ensureImports(source, names) {
  const importRe = /import\s*\{([^}]*)\}\s*from\s*"@\/components\/ui\/dialog"/;
  const m = source.match(importRe);
  if (!m) return source;
  const existing = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  const missing = names.filter((n) => !existing.includes(n));
  if (!missing.length) return source;
  const merged = [...new Set([...existing, ...missing])].sort();
  return source.replace(importRe, `import { ${merged.join(", ")} } from "@/components/ui/dialog"`);
}
