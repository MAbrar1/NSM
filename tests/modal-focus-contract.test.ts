import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/* ═══════════════════════════════════════════════════════════════
   MODAL FOCUS CONTRACT
   An overlay that says `aria-modal="true"` is telling assistive tech
   that everything behind it is inert. If it does not also move focus
   in, trap Tab, and hand focus back to whatever opened it, that
   claim is a lie the keyboard user pays for.

   Radix's <Dialog> is the contract, applied for free. The overlays
   this codebase builds by hand — the mobile nav drawer, the ⌘K
   command palette, the shortcuts modal, the image lightbox, the POS
   cart sheet — must opt in explicitly through `useModalFocus`.

   The live behaviour is measured end-to-end in audit-neu-pages.mjs;
   this test is the static half, so a NEW overlay cannot announce
   modality without the contract and slip in unnoticed.
   ═══════════════════════════════════════════════════════════════ */

const SRC = join(process.cwd(), "src");

/** The dialog primitive itself is where the Radix contract is wired.
    Paths below are always forward-slash normalised, on every platform. */
const EXEMPT = new Set(["src/components/ui/dialog.tsx"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    // .tsx only: both rules are about JSX attributes, and scanning plain .ts
    // would flag the hook's own declaration of `useModalFocus(`.
    else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/**
 * Comments are stripped first: this file's own docs, and the docs in
 * layout.tsx, quote the attributes and would otherwise match.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** `aria-modal="true"` or `aria-modal={cond ? true : undefined}`. */
const MODALITY_CLAIM = /aria-modal=(?:"true"|"\{true\}"|\{)/;

describe("modal focus contract", () => {
  const files = sourceFiles(SRC).map((path) => ({
    path,
    rel: relative(process.cwd(), path).replace(/\\/g, "/"),
    code: stripComments(readFileSync(path, "utf8")),
  }));

  it("every aria-modal overlay is backed by Radix Dialog or useModalFocus", () => {
    const unbacked = files
      .filter((f) => MODALITY_CLAIM.test(f.code))
      .filter((f) => !EXEMPT.has(f.rel))
      .filter(
        (f) =>
          // a CALL, not a stray import: `useModalFocus(` never matches the
          // import binding, so importing without wiring the panel up fails.
          !/useModalFocus\s*\(/.test(f.code) &&
          !f.code.includes("<DialogContent") &&
          !f.code.includes("DialogPrimitive.Content")
      )
      .map((f) => f.rel);
    assert.deepEqual(
      unbacked,
      [],
      "these files announce aria-modal without a focus contract: add useModalFocus, or build on <DialogContent>"
    );
  });

  it("a hand-rolled panel that traps focus also declares the modality", () => {
    // The converse rule: the trap and the announcement have to travel
    // together. A trapped panel with no role is invisible to a screen
    // reader; a role with no trap strands the keyboard user behind it.
    const silent = files
      .filter((f) => f.code.includes("useModalFocus("))
      .filter((f) => !/role="(dialog|alertdialog)"/.test(f.code))
      .map((f) => f.rel);
    assert.deepEqual(silent, [], "a focus-trapped panel must declare role=dialog so it is announced");
  });

  it("the probe finds the overlays it claims to cover", () => {
    // A guard on the guard: if the attribute syntax changes, the filters
    // above would quietly match nothing and both checks would pass by
    // vacuity. Name the files we expect to be in scope.
    const claiming = files.filter((f) => MODALITY_CLAIM.test(f.code)).map((f) => f.rel);
    for (const expected of [
      "src/app/(dashboard)/layout.tsx",
      "src/app/(dashboard)/pos/page.tsx",
      "src/components/ui/image-lightbox.tsx",
    ]) {
      assert.ok(claiming.includes(expected), `${expected} should still be recognised as a modal overlay`);
    }
  });
});
