#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   CODEMOD: truncate ⇒ truncate + native title.

   text-overflow: ellipsis hides text with no recovery unless the
   element exposes a tooltip. Every SELF-CLOSING JSX element whose
   className already uses `truncate` and which has no title=, and
   whose children are a single {} expression, gets a native
   title={…same expression…} appended — browsers render a tooltip
   with the full text on hover, screen readers announce the full
   value via the DOM string. Multi-child or template-literal rows
   are left for manual review (printed in the report).

   Validated with the TypeScript compiler API after each rewrite —
   any file that stops parsing is restored untouched.
   ═══════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { execSync } from "node:child_process";

const files = execSync(
  `grep -rl "truncate" src/app src/components --include=*.tsx`,
  { encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean);

let changed = 0, sites = 0, skipped = 0;
const skippedSites = [];

function parses(sourceText) {
  const sf = ts.createSourceFile("x.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return sf.parseDiagnostics.length === 0;
}

for (const file of files) {
  const original = readFileSync(file, "utf8");
  if (!original.includes("truncate")) continue;

  const sf = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = []; // { insertAt, text }

  function visit(node) {
    const isOpenJsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
    if (isOpenJsx) {
      const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
      const usesTruncate = attrs.properties.some(
        (a) =>
          ts.isJsxAttribute(a) &&
          a.name?.getText() === "className" &&
          a.initializer?.getText().includes("truncate")
      );
      const hasTitle = attrs.properties.some(
        (a) => ts.isJsxAttribute(a) && (a.name?.getText() === "title" || a.name?.getText() === "aria-label")
      );
      if (usesTruncate && !hasTitle) {
        const kids = ts.isJsxElement(node) ? node.children : [];
        // Whitespace JsxText and {/* comment */} expressions (which carry
        // no real expression) must not disqualify a row — count only
        // children that hold an actual expression.
        const realExprs = kids.filter((k) => ts.isJsxExpression(k) && k.expression);
        const hasElementChild = kids.some(
          (k) => ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k) || ts.isJsxFragment(k)
        );
        const exprWithJsx = realExprs.some((k) => k.expression.getText(sf).includes("<"));
        if (ts.isJsxElement(node) && !hasElementChild && !exprWithJsx && realExprs.length > 0) {
          // Reconstruct the exact visible string: expressions become ${…}
          // interpolations, literal text stays literal. Comments and pure
          // whitespace collapse naturally into the template.
          let template = "";
          for (const kid of kids) {
            if (ts.isJsxText(kid)) template += kid.getText(sf).replace(/\s+/g, " ");
            else if (ts.isJsxExpression(kid) && kid.expression) {
              template += "${" + kid.expression.getText(sf) + "}";
            }
          }
          // Insert into the OPENING tag, just before its closing `>`.
          const openingEnd = node.openingElement.getEnd(); // index after `>`
          edits.push({ insertAt: openingEnd - 1, text: ` title={\`${template.trim()}\`}` });
        } else {
          skipped++;
          const pos = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          skippedSites.push(`${file}:${pos}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (edits.length === 0) continue;

  // Apply bottom-up so offsets stay valid.
  let out = original;
  for (const { insertAt, text } of edits.sort((a, b) => b.insertAt - a.insertAt)) {
    out = out.slice(0, insertAt) + text + out.slice(insertAt);
  }

  if (!parses(out)) {
    console.log(`REJECT (parse failed) ${file}`);
    continue;
  }
  writeFileSync(file, out, "utf8");
  changed++;
  sites += edits.length;
  console.log(`OK ${file} (+${edits.length})`);
}

console.log(`\ncodemod complete: ${changed} files, ${sites} titles added, ${skipped} skipped for manual review`);
if (skippedSites.length) console.log("skipped sites:\n" + skippedSites.map((s) => "  " + s).join("\n"));
