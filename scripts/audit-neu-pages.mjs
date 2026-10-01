/* NEU PAGE AUDIT — real pages, real computed styles.

   Companion to audit-neu-theme.mjs. That one proves the design system
   itself (tokens, recipes, WCAG ratios) against a fixture and needs no
   server — so it runs in CI. This one proves the MIGRATED PAGE MARKUP:
   it drives the real app, scans every rendered element, and fails if any
   element still resolves to the legacy `--color-surface-*` palette.

   Why this is needed: Tailwind emits NOTHING for an unknown class, so a
   typo'd utility or a half-migrated file is silent. Only rendering the
   real pages catches it.

   It also probes NON-RESTING states. A scan of resting computed styles
   cannot see a surviving `hover:bg-surface-50` or `focus:ring-brand-500/20`:
   those utilities compile perfectly, they just never paint, because the
   audit never enters the state that activates them. CDP's
   CSS.forcePseudoState runs the real cascade for :hover / :focus-visible
   with no mouse or keyboard, and transitions are killed first so the
   first read is already the final value.

   States covered:
     :hover           — a bare `hover:` on the element itself
     :focus-visible   — every `.neu-focus` recipe
     :active          — a bare `active:` (the pressed affordance)
     :disabled        — explicit `disabled:` utilities AND every class
                        globals.css writes a `:disabled` rule for
     group-* / peer-* — the relational variants, forced on the ANCESTOR
                        (`.group`) or the PRECEDING SIBLING (`.peer`)

   A relational variant whose marker class the DOM does not actually
   provide is reported as an ORPHAN. That is the only way to catch a dead
   `peer-disabled:`: the utility compiles, the selector can never match,
   nothing paints, and a resting scan sees a perfectly clean page.

   Usage:
     npm run build && npx next start -p 3311   # in one shell
     node audit-neu-pages.mjs                  # in another
   Env: BASE_URL (default http://localhost:3311), CHROME_PATH.
   Exits non-zero if any check fails.
*/
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CHROME = process.env.CHROME_PATH || {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
}[process.platform] || "/usr/bin/google-chrome";

const BASE = process.env.BASE_URL || "http://localhost:3311";
// Outside the project on purpose: a Chrome profile inside the watched tree
// makes `next dev` recompile in a loop and truncate .next, which 500s every
// API route. `.gitignore` already records that rule for `.dbg-profile*`; this
// script was still writing its profile into the tree.
const PROFILE = tmpdir() + "/codebuff-neu-pages-profile";
const GLOBALS = process.cwd() + "/src/app/globals.css";
const PAGES = [
  "/dashboard", "/orders", "/inventory", "/products", "/customers", "/pos",
  // The reporting and settings surfaces carry the densest toolbar/menu state
  // in the app and were never scanned at all.
  "/reports/sales", "/reports/inventory", "/purchase-orders", "/settings",
];

/* Control classes with a styled `:disabled` state, read once from the
   stylesheet so the page probe and the theme ratchet cannot disagree. */
const DISABLED_STYLED = disabledStyledClasses(GLOBALS);

if (!existsSync(CHROME)) {
  console.error(`AUDIT ERROR: no Chrome at ${CHROME}\nSet CHROME_PATH to the browser binary.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
let failures = 0;
function check(name, actual, pass) {
  const ok = typeof pass === "function" ? pass(actual) : actual === pass;
  if (!ok) failures++;
  out.push((ok ? "PASS  " : "FAIL  ") + name.padEnd(56) + " " + JSON.stringify(actual));
}

let chrome = null, ws = null, msgId = 0;
const pending = new Map();
/* Console errors + uncaught exceptions, collected for the failure
   diagnostics below ("not rendered" is useless if you can't see the
   page's last words). */
const cdpErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout: " + method)); }
    }, 30000);
  });
}

async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}

/** A real key press over CDP, so the app's own handlers run.
    `rawKeyDown` (not `keyDown`) for Tab: only the raw form makes Chrome run
    the key's DEFAULT action, which is what actually moves focus. */
async function pressKey(key) {
  const vk = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }[key] ?? 0;
  const type = key === "Tab" ? "rawKeyDown" : "keyDown";
  await send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk });
}

async function waitFor(expression, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evalJs(expression)) return true; } catch { /* navigating */ }
    await sleep(250);
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════
   The legacy palette, as the engine resolves it. ONE source of truth,
   shared by the resting scan and the hover/focus probes.

   Light mode only: dark mode legitimately uses some colours that
   coincide with the light legacy palette (#94a3b8 is BOTH surface-400
   and dark --neu-text-muted), so only the light values are unambiguous
   legacy markers. Anything here is a value the neu palette never
   produces, so a hit means an unmigrated class survived.
   ═══════════════════════════════════════════════════════════════ */
const LEGACY = {
  text: ["rgb(100, 116, 139)", "rgb(148, 163, 184)", "rgb(15, 23, 42)", "rgb(2, 6, 23)", "rgb(203, 213, 225)"],
  bg: ["rgb(255, 255, 255)", "rgb(248, 250, 252)", "rgb(241, 245, 249)", "rgb(226, 232, 240)", "rgb(203, 213, 225)"],
  border: ["rgb(226, 232, 240)", "rgb(241, 245, 249)", "rgb(203, 213, 225)"],
};
const LEGACY_ANY = new Set(Object.values(LEGACY).flat());

/* State probes read colours the element may not actually be painting, so
   the resting marker set needs two corrections:

   • WHITE. `rgb(255, 255, 255)` is BOTH the legacy `bg-white` AND the
     legitimate `--neu-solid-ink` — the fixed ink the spec puts on solid
     accent fills. It is therefore a legacy marker as a FILL or a BORDER,
     never as ink: a white label on a solid cyan button is the design
     system, not a leftover.
   • BORDERS. `border-top-color` defaults to `currentColor`, so a white
     text colour reports a white border on an element with no border at
     all. Only a non-zero border width counts.
*/
const LEGACY_STATE_INK = new Set([...LEGACY_ANY].filter((v) => v !== "rgb(255, 255, 255)"));

/** Legacy markers painted by one element in a forced state, as strings. */
const stateLegacyIn = (s) => {
  const hits = [];
  if (LEGACY_STATE_INK.has(s.color)) hits.push("color=" + s.color);
  if (LEGACY_ANY.has(s.backgroundColor)) hits.push("backgroundColor=" + s.backgroundColor);
  if (parseFloat(s.borderTopWidth) > 0 && LEGACY_ANY.has(s.borderTopColor)) hits.push("borderTopColor=" + s.borderTopColor);
  return hits;
};

/* Colour-bearing properties read in the forced states. boxShadow covers
   Tailwind's `ring-*`; backgroundImage covers gradient stops. */
const STATE_PROPS = ["color", "backgroundColor", "backgroundImage", "borderTopColor", "boxShadow"];

/* Transitions would make the first read after forcing a state return the
   MIDPOINT of the tween, so they are disabled for the duration. */
const NO_TRANSITION_ON =
  "(() => { const s = document.createElement('style'); s.id = 'neu-audit-notransition'; " +
  "s.textContent = '* { transition: none !important; }'; document.head.appendChild(s); })()";
const NO_TRANSITION_OFF = "document.getElementById('neu-audit-notransition')?.remove()";

/* ── state probes ──────────────────────────────────────────────────
   Written as REAL functions and serialised with toString(), so the
   injected source needs no string-escaping gymnastics. Any comparison
   against LEGACY_ANY happens here in Node, on the values the engine
   handed back — the probes stay pure DOM readers. */

/** Tag every element carrying a BARE `hover:` colour utility. */
function tagHoverable() {
  let n = 0;
  for (const el of document.querySelectorAll("body *")) {
    const cls = typeof el.className === "string" ? el.className : "";
    // Only a bare `hover:` token counts. `group-hover:` / `peer-hover:`
    // paint a DIFFERENT element than the one holding the class, so
    // forcing :hover on that holder would prove nothing.
    if (!cls.split(/\s+/).some((t) => /^hover:(bg|text|border|ring|shadow|outline|from|via|to)-/.test(t))) continue;
    el.setAttribute("data-neu-hover", String(n++));
  }
  return n;
}

/** Tag every element carrying the neu focus recipe. */
function tagFocusable() {
  let n = 0;
  for (const el of document.querySelectorAll("body *")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls.split(/\s+/).includes("neu-focus")) continue;
    el.setAttribute("data-neu-focus", String(n++));
  }
  return n;
}

/** Colour-bearing computed values of one tagged element. `translate`,
    `scale` and `opacity` are included because several affordances are a
    tween rather than a colour change (Tailwind v4 emits the modern
    `translate` / `scale` properties, not a `transform` matrix). */
function readState(kind, i) {
  const el = document.querySelector('[data-neu-' + kind + '="' + i + '"]');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    backgroundImage: cs.backgroundImage,
    borderTopColor: cs.borderTopColor,
    borderTopWidth: cs.borderTopWidth,
    outlineColor: cs.outlineColor,
    outlineStyle: cs.outlineStyle,
    boxShadow: cs.boxShadow,
    opacity: cs.opacity,
    cursor: cs.cursor,
    pointerEvents: cs.pointerEvents,
    transform: cs.transform,
    translate: cs.translate,
    scale: cs.scale,
  };
}

/* ── :active / :disabled / relational probes ───────────────────────
   Each of these needs a different targeting strategy, so each gets its
   own tagger; the node side drives them all through readState above. */

/** Props that count as "the affordance painted something". Wider than
    STATE_PROPS because a pressed or disabled state is usually expressed
    as opacity / cursor / pointer-events / a scale tween, not a colour:
    `active:scale-95` and `disabled:cursor-not-allowed` are real feedback
    and must not read as a dead class. */
const PRESS_PROPS = [
  "color", "backgroundColor", "backgroundImage", "borderTopColor",
  "boxShadow", "opacity", "cursor", "pointerEvents", "transform", "translate", "scale",
];

/** [class prefix, marker class, pseudo to force] for the variants that
    paint an element OTHER than the one carrying the class. */
const REL_MARKERS = [
  ["group-hover:", "group", "hover"],
  ["group-active:", "group", "active"],
  ["group-focus-visible:", "group", "focus-visible"],
  ["peer-hover:", "peer", "hover"],
  ["peer-active:", "peer", "active"],
  ["peer-focus-visible:", "peer", "focus-visible"],
  ["peer-disabled:", "peer", "disabled"],
];

/** The class names globals.css writes a `:<class>:disabled` rule for.
    Read from the stylesheet rather than hard-coded, so a new control
    recipe is probed automatically instead of silently going uncovered. */
function disabledStyledClasses(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  const found = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*):disabled/g)) found.add(m[1]);
  return [...found].sort();
}

/** Tag every RENDERED element carrying a bare `active:` utility. Hidden
    elements are skipped: forcePseudoState cannot repaint a `display:none`
    box, so they would read as "stuck" and fail for the wrong reason. */
function tagPressable() {
  let n = 0;
  for (const el of document.querySelectorAll("body *")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls.split(/\s+/).some((t) => t.startsWith("active:"))) continue;
    if (el.getClientRects().length === 0) continue;
    el.setAttribute("data-neu-press", String(n++));
  }
  return n;
}

/** Tag every rendered form control with a disabled state to check: an
    explicit `disabled:` utility, or a class globals.css styles for
    `:disabled`. `disabled` must be a settable property — otherwise
    toggling it cannot make the pseudo-class match. */
function tagDisableable(styled) {
  const STYLED = new Set(styled);
  let n = 0;
  for (const el of document.querySelectorAll("button, input, select, textarea, fieldset, optgroup, option")) {
    if (!("disabled" in el)) continue;
    const cls = typeof el.className === "string" ? el.className : "";
    const toks = cls.split(/\s+/);
    if (!toks.some((t) => t.startsWith("disabled:")) && !toks.some((t) => STYLED.has(t))) continue;
    if (el.getClientRects().length === 0) continue;
    el.setAttribute("data-neu-disabled", String(n));
    el.setAttribute("data-neu-disabled-was", el.disabled ? "1" : "0");
    n++;
  }
  return n;
}

/** Targets that react to an ANCESTOR (`.group`) or a PRECEDING SIBLING
    (`.peer`). Returns the pairs plus every variant whose marker class the
    DOM does not provide — those are dead classes, not untested ones. */
function tagRelational(markers) {
  const pairs = [], orphans = new Set(), owners = new Map();
  let tid = 0, oid = 0;
  for (const el of document.querySelectorAll("body *")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls) continue;
    const toks = cls.split(/\s+/);
    for (const [prefix, marker, pseudo] of markers) {
      if (!toks.some((t) => t.startsWith(prefix))) continue;
      let owner = null;
      if (marker === "peer") {
        for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
          const sc = typeof s.className === "string" ? s.className.split(/\s+/) : [];
          if (sc.includes("peer")) { owner = s; break; }
        }
      } else {
        for (let a = el.parentElement; a; a = a.parentElement) {
          const ac = typeof a.className === "string" ? a.className.split(/\s+/) : [];
          if (ac.includes("group")) { owner = a; break; }
        }
      }
      if (!owner) { orphans.add(prefix); continue; }
      let id = owners.get(owner);
      if (id === undefined) { id = oid++; owners.set(owner, id); owner.setAttribute("data-neu-owner", String(id)); }
      el.setAttribute("data-neu-target-" + pseudo, String(tid));
      pairs.push({ oid: id, tid: tid++, pseudo, prefix });
    }
  }
  return { pairs, orphans: [...orphans] };
}

/** `:disabled` is an element PROPERTY, not a forceable pseudo-class, so it
    is toggled directly — that makes the pseudo-class match for real. */
const setDisabled = (i, on) =>
  '(() => { const el = document.querySelector(\'[data-neu-disabled="' + i + '"]\'); ' +
  "if (!el) return null; el.disabled = " + on + "; return true; })()";

const restoreDisabled = (i) =>
  '(() => { const el = document.querySelector(\'[data-neu-disabled="' + i + '"]\'); ' +
  "if (!el) return null; el.disabled = el.getAttribute('data-neu-disabled-was') === '1'; return true; })()";

const setOwnerDisabled = (i, on) =>
  '(() => { const el = document.querySelector(\'[data-neu-owner="' + i + '"]\'); ' +
  "if (!el || !('disabled' in el)) return null; el.disabled = " + on + "; return true; })()";

/**
 * Drives :active, :disabled and the relational variants. Returns raw
 * engine values; every pass/fail judgement happens back in Node.
 */
async function probeExtraStates(styled) {
  await evalJs(NO_TRANSITION_ON);
  const doc = (await send("DOM.getDocument", { depth: 1 })).root;
  const nodeIdOf = async (sel) => (await send("DOM.querySelector", { nodeId: doc.nodeId, selector: sel })).nodeId;

  const PRESS_CAP = 25, DIS_CAP = 25, REL_CAP = 45;
  const report = {
    press: { total: 0, probed: 0, changed: 0, stuck: [], legacy: [] },
    dis: { total: 0, probed: 0, changed: 0, stuck: [], legacy: [], invisible: [] },
    rel: { total: 0, probed: 0, changed: 0, stuck: [], legacy: [], orphan: [] },
  };

  const changedIn = (a, b) => PRESS_PROPS.some((p) => a[p] !== b[p]);
  const read = (kind, i) => evalJs('(' + readState.toString() + ')("' + kind + '", ' + i + ')');

  // ── bare :active ──
  report.press.total = await evalJs("(" + tagPressable.toString() + ")()");
  for (let i = 0; i < Math.min(report.press.total, PRESS_CAP); i++) {
    const sel = '[data-neu-press="' + i + '"]';
    const id = await nodeIdOf(sel);
    if (!id) continue;
    const rest = await read("press", i);
    await send("CSS.forcePseudoState", { nodeId: id, forcedPseudoClasses: ["active"] });
    const down = await read("press", i);
    await send("CSS.forcePseudoState", { nodeId: id, forcedPseudoClasses: [] });
    if (!rest || !down) continue;
    report.press.probed++;
    if (changedIn(rest, down)) report.press.changed++;
    else if (report.press.stuck.length < 5) report.press.stuck.push(sel);
    for (const h of stateLegacyIn(down)) if (report.press.legacy.length < 5) report.press.legacy.push(h + " @" + sel);
  }

  // ── :disabled ──
  report.dis.total = await evalJs("(" + tagDisableable.toString() + ")(" + JSON.stringify(styled) + ")");
  for (let i = 0; i < Math.min(report.dis.total, DIS_CAP); i++) {
    const sel = '[data-neu-disabled="' + i + '"]';
    if (!(await nodeIdOf(sel))) continue;
    await evalJs(setDisabled(i, false));
    const enabled = await read("disabled", i);
    await evalJs(setDisabled(i, true));
    const off = await read("disabled", i);
    await evalJs(restoreDisabled(i));
    if (!enabled || !off) continue;
    report.dis.probed++;
    if (changedIn(enabled, off)) report.dis.changed++;
    else if (report.dis.stuck.length < 5) report.dis.stuck.push(sel);
    for (const h of stateLegacyIn(off)) if (report.dis.legacy.length < 5) report.dis.legacy.push(h + " @" + sel);
    // Ink identical to the fill is invisible — worse than merely
    // low-contrast, and never what `disabled:opacity-*` intended.
    if (off.color === off.backgroundColor && report.dis.invisible.length < 5) report.dis.invisible.push(sel);
  }

  // ── relational: group-* / peer-* ──
  const rel = await evalJs("(" + tagRelational.toString() + ")(" + JSON.stringify(REL_MARKERS) + ")");
  report.rel.orphan = (rel.orphans ?? []).slice(0, 6);
  report.rel.total = (rel.pairs ?? []).length;
  for (const pair of (rel.pairs ?? []).slice(0, REL_CAP)) {
    const ownerSel = '[data-neu-owner="' + pair.oid + '"]';
    const targetSel = '[data-neu-target-' + pair.pseudo + '="' + pair.tid + '"]';
    const oid = await nodeIdOf(ownerSel);
    if (!oid) { continue; }
    const rest = await read("target-" + pair.pseudo, pair.tid);
    if (pair.pseudo === "disabled") await evalJs(setOwnerDisabled(pair.oid, true));
    else await send("CSS.forcePseudoState", { nodeId: oid, forcedPseudoClasses: [pair.pseudo] });
    const on = await read("target-" + pair.pseudo, pair.tid);
    if (pair.pseudo === "disabled") await evalJs(setOwnerDisabled(pair.oid, false));
    else await send("CSS.forcePseudoState", { nodeId: oid, forcedPseudoClasses: [] });
    if (!rest || !on) continue;
    report.rel.probed++;
    if (changedIn(rest, on)) report.rel.changed++;
    else if (report.rel.stuck.length < 6) report.rel.stuck.push(pair.prefix + " -> " + targetSel);
    for (const h of stateLegacyIn(on)) if (report.rel.legacy.length < 6) report.rel.legacy.push(pair.prefix + " " + h + " @" + targetSel);
  }

  await evalJs(NO_TRANSITION_OFF);
  return report;
}

/** The legacy focus-indicator cluster, if any of it is still in the DOM.
    Mirrors scripts/codemod-neu-markup.mjs `isLegacyFocus`. */
function legacyFocusTokens() {
  const BASE = /^(?:focus|focus-visible):(?:outline-none|outline-[^:]+|ring-\d+|ring-offset-\d+|ring-(?:brand|danger|surface)-\d+(?:\/\d+)?|border-(?:brand|danger)-\d+)$/;
  const hits = [];
  for (const el of document.querySelectorAll("body *")) {
    const cls = typeof el.className === "string" ? el.className : "";
    for (const t of cls.split(/\s+/)) if (BASE.test(t)) hits.push(t);
  }
  return [...new Set(hits)].sort();
}

const SCAN = (legacy) => `(() => {
  const LEGACY_TEXT = new Set(${JSON.stringify(legacy.text)});
  const LEGACY_BG = new Set(${JSON.stringify(legacy.bg)});
  const LEGACY_BORDER = new Set(${JSON.stringify(legacy.border)});
  const SKIP = new Set(["IMG", "SVG", "PATH", "CANVAS", "SCRIPT", "STYLE", "VIDEO", "DEFS"]);
  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const hits = [];
  let scanned = 0, sunkenExact = 0, sunkenExactOk = 0;
  const samples = [];
  const sunken = getComputedStyle(document.documentElement).getPropertyValue("--neu-sunken").trim();
  const probe = document.createElement("div");
  probe.style.color = sunken;
  document.body.appendChild(probe);
  const sunkenResolved = getComputedStyle(probe).color;
  probe.remove();

  for (const el of document.querySelectorAll("body *")) {
    if (SKIP.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    scanned++;

    // Real usage of the new utility must resolve, not silently no-op.
    // Matched as a WHOLE token: a prefixed usage (hover:bg-neu-sunken) is
    // transparent at rest by design, and Tailwind preserves /opacity
    // suffixes (bg-neu-sunken/60) whose colour is a mix, not the token.
    const cls = typeof el.className === "string" ? el.className : "";
    if (cls.split(/\s+/).includes("bg-neu-sunken")) {
      sunkenExact++;
      if (cs.backgroundColor === sunkenResolved) sunkenExactOk++;
      else if (samples.length < 3) samples.push(cls.slice(0, 140));
    }

    if (LEGACY_TEXT.has(cs.color)) hits.push({ why: "text", val: cs.color, el: describe(el) });
    if (LEGACY_BG.has(cs.backgroundColor) && rect.width * rect.height > 2000 && cs.backgroundImage === "none") {
      hits.push({ why: "bg", val: cs.backgroundColor, el: describe(el) });
    }
    if (parseFloat(cs.borderTopWidth) > 0 && LEGACY_BORDER.has(cs.borderTopColor)) {
      hits.push({ why: "border", val: cs.borderTopColor, el: describe(el) });
    }
  }

  // One example per distinct legacy value keeps the report readable.
  const seen = new Set(), unique = [];
  for (const h of hits) {
    const k = h.why + h.val;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(h);
  }
  return {
    scanned, unique,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyInk: getComputedStyle(document.body).color,
    sunkenExact, sunkenExactOk, samples,
  };
})()`;

/**
 * For every tagged hover affordance: read the resting colours, force
 * :hover, read again, unforce. Then the same for :focus-visible on every
 * element carrying the neu focus recipe. Returns raw engine values; all
 * legacy/ratio judgement happens in the caller.
 */
async function probeStates() {
  await evalJs(NO_TRANSITION_ON);

  const doc = (await send("DOM.getDocument", { depth: 1 })).root;
  const nodeIdOf = async (sel) => (await send("DOM.querySelector", { nodeId: doc.nodeId, selector: sel })).nodeId;

  // Resolve the focus ring to a concrete rgb(), so the comparison is
  // against what the engine actually paints rather than the raw hex.
  const ringRgb = await evalJs(
    "(() => { const p = document.createElement('div'); " +
    "p.style.color = getComputedStyle(document.documentElement).getPropertyValue('--neu-focus-ring').trim(); " +
    "document.body.appendChild(p); const v = getComputedStyle(p).color; p.remove(); return v; })()"
  );

  // The same colour can be painted as rgb(...), rgba(..., 0.5) or part of
  // a shadow list, so the RING is matched on its bare "r, g, b" triplet.
  const ringTriplet = ringRgb.replace(/[^0-9, ]/g, "").trim();

  const HOVER_CAP = 45, FOCUS_CAP = 35;
  const report = {
    ringRgb, ringTriplet,
    hoverTotal: 0, hoverProbed: 0, hoverChanged: 0, hoverLegacy: [], hoverStuck: [],
    focusTotal: 0, focusProbed: 0, focusRinged: 0, focusLegacy: [],
    legacyFocus: [],
  };

  // ── :hover ──
  report.hoverTotal = await evalJs("(" + tagHoverable.toString() + ")()");
  for (let i = 0; i < Math.min(report.hoverTotal, HOVER_CAP); i++) {
    const sel = '[data-neu-hover="' + i + '"]';
    const id = await nodeIdOf(sel);
    if (!id) continue;
    const rest = await evalJs("(" + readState.toString() + ")(\"hover\", " + i + ")");
    await send("CSS.forcePseudoState", { nodeId: id, forcedPseudoClasses: ["hover"] });
    const over = await evalJs("(" + readState.toString() + ")(\"hover\", " + i + ")");
    await send("CSS.forcePseudoState", { nodeId: id, forcedPseudoClasses: [] });
    if (!rest || !over) continue;

    report.hoverProbed++;
    if (STATE_PROPS.some((p) => rest[p] !== over[p])) report.hoverChanged++;
    // Only ever populated on failure; the selector is enough to find the
    // element in devtools with the same query.
    else if (report.hoverStuck.length < 5) report.hoverStuck.push(sel);

    for (const h of stateLegacyIn(over)) if (report.hoverLegacy.length < 5) report.hoverLegacy.push(h + " @" + sel);
  }

  // ── :focus-visible ──
  report.focusTotal = await evalJs("(" + tagFocusable.toString() + ")()");
  for (let i = 0; i < Math.min(report.focusTotal, FOCUS_CAP); i++) {
    const sel = '[data-neu-focus="' + i + '"]';
    const id = await nodeIdOf(sel);
    if (!id) continue;
    await send("CSS.forcePseudoState", { nodeId: id, forcedPseudoClasses: ["focus", "focus-visible"] });
    const st = await evalJs("(" + readState.toString() + ")(\"focus\", " + i + ")");
    await send("CSS.forcePseudoState", { nodeId: id, forcedPseudoClasses: [] });
    if (!st) continue;

    report.focusProbed++;
    // A ring counts whether it is painted as an outline, a border colour
    // (`.neu-input:focus`) or the glow in a box-shadow list — all three
    // are the neu recipe, just different properties.
    const ringed =
      (st.outlineStyle !== "none" && st.outlineColor === ringRgb) ||
      st.borderTopColor === ringRgb ||
      st.boxShadow.includes(ringTriplet);
    if (ringed) report.focusRinged++;
    for (const h of stateLegacyIn(st)) if (report.focusLegacy.length < 5) report.focusLegacy.push(h + " @" + sel);
  }

  report.legacyFocus = await evalJs("(" + legacyFocusTokens.toString() + ")()");
  await evalJs(NO_TRANSITION_OFF);
  return report;
}

/* ── overlay layout probe ───────────────────────────────────────────
   "Proper layout" for a modal is measurable: the panel must FIT the
   viewport at every size we claim to support, the page must not gain a
   horizontal scrollbar, and content taller than the panel must stay
   reachable. Only ADDITIVE triggers are clicked (never delete/remove/
   pay/…), and nothing inside an open overlay is ever clicked, so this
   cannot mutate data: it opens, measures at three widths, then Escape. */

const OVERLAY_VIEWPORTS = [[1440, 900, false], [768, 1024, true], [375, 667, true]];

/** Legacy LIGHT-mode values that must NOT survive into `.dark`. */
const LIGHT_ONLY = {
  text: ["rgb(51, 65, 85)", "rgb(71, 85, 105)", "rgb(90, 103, 121)"],
  bg: ["rgb(230, 236, 240)"],
  border: ["rgb(186, 190, 204)"],
};

/**
 * Click the Nth additive trigger, returning its accessible name.
 *
 * Anchors with a real href are SKIPPED. An app-router `<a href="/pos">`
 * navigates on click, which replaces the page underneath the probe: every
 * subsequent measurement then describes a surface the audit never asked
 * about. That is not hypothetical — the dashboard's quick-action cards are
 * anchors, and clicking one took the probe to /pos, where a POS keypad's
 * `active:` buttons made the results look plausible while the dashboard's
 * own overlay was never measured at all.
 */
function clickOverlayTrigger(sel, index, seen) {
  const SAFE = /(add|new|create|view|detail|edit|preview|print|shortcut|search|help|keyboard|quick|filter)/i;
  const UNSAFE = /(delete|remove|clear|log ?out|sign ?out|reset|archive|export|import|save|submit|pay|refund|void)/i;
  const already = new Set(seen);
  const candidates = [];
  for (const el of document.querySelectorAll("button, [role=button], a")) {
    if (el.closest(sel)) continue;
    if (el.disabled) continue;
    if (el.tagName === "A" && el.hasAttribute("href") && !/^#/.test(el.getAttribute("href") || "")) continue;
    // `title` matters as much as `aria-label`: the layout's icon-only buttons
    // carry their whole accessible name in `title` and have NO text content,
    // so a textContent-only lookup skips them — and with them the command
    // palette and the shortcuts modal, two of the four `role="dialog"`
    // overlays in the app. The name is tested in FULL and only shortened for
    // display, because the header search button's label is a sentence.
    const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
      .replace(/\s+/g, " ").trim();
    if (!name || name.length > 120 || already.has(name) || UNSAFE.test(name) || !SAFE.test(name)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    // Page-local triggers sort first: the header is shared chrome, and if it
    // always won, every page would report the same two overlays and no page's
    // own dialog would ever be measured.
    candidates.push({ el, name, chrome: !!el.closest("header, nav") });
  }
  candidates.sort((a, b) => Number(a.chrome) - Number(b.chrome));
  const pick = candidates[index];
  if (!pick) return null;
  // Focus BEFORE clicking, the way a real mousedown does. A programmatic
  // `.click()` never moves focus, so without this every anchored popover
  // would be measured with focus still on <body> and the "did it keep focus"
  // rule could not tell a correct popover from one that dumps focus.
  pick.el.focus();
  pick.el.click();
  // Remember what opened the overlay: the focus-return rule needs it, and it
  // is unrecoverable once the overlay has been dismissed.
  window.__neuTrigger = pick.el;
  window.__neuTriggerFocused = document.activeElement === pick.el;
  return pick.name;
}

/**
 * Every overlay the app actually renders.
 *
 * `[role="dialog"]` alone missed four real ones: the export menu
 * (`role="menu"`), the currency picker and the inventory product combobox
 * (`role="listbox"`), and — until this round — the two header dropdowns and
 * the mobile nav drawer, which carried no role at all and were therefore
 * invisible to this probe *by construction*. They declare one now (see
 * layout.tsx), which is the only reason they are measurable here at all.
 */
const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]';

/** The same set, restricted to instances that appeared AFTER the stamp. */
const NOT_STAMPED = (sel) =>
  sel.split(", ").map((s) => s + ":not([data-neu-mounted])").join(", ");

/** Stamp whatever overlays are already mounted, so the one that appears
    after the click can be told apart from a globally-rendered overlay. */
const MARK_MOUNTED = (sel) =>
  `document.querySelectorAll('${sel}').forEach((d) => d.setAttribute('data-neu-mounted', ''))`;

/**
 * Geometry of the NEWLY OPENED overlay against the emulated viewport.
 *
 * The panel is picked by "not present before the click", not by
 * `querySelector` (which returns the FIRST in DOM order). That matters:
 * a layout-level dialog — the one-time onboarding modal — is rendered by
 * the dashboard shell, so a first-match query measures IT on every page,
 * and its 480×516 box is plausible enough that the checks stayed green
 * while the real dialog was never measured at all.
 */
function measureOverlay(sel) {
  const all = [...document.querySelectorAll(sel)];
  const fresh = all.filter((d) => !d.hasAttribute("data-neu-mounted"));
  let panel = fresh[fresh.length - 1];
  if (!panel) return null;
  const vw = window.innerWidth, vh = window.innerHeight;

  // A layout-level overlay commonly puts `role="dialog"` on a full-bleed
  // `inset-0` WRAPPER and keeps the real card as a child. Measuring the
  // wrapper is vacuous — an `inset-0` box always "fits" the viewport, so
  // the check could never fail however badly the card overflowed. Descend
  // to the visible card while the box is still full-bleed, skipping the
  // scrim (which is itself full-bleed and would otherwise look largest).
  for (let depth = 0; depth < 3; depth++) {
    const b = panel.getBoundingClientRect();
    if (!(b.width >= vw * 0.98 && b.height >= vh * 0.98)) break;
    let best = null, bestArea = 0;
    for (const el of panel.children) {
      const rr = el.getBoundingClientRect();
      if (rr.width < 40 || rr.height < 40) continue;
      if (rr.width >= vw * 0.98 && rr.height >= vh * 0.98) continue;
      const area = rr.width * rr.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (!best) break;
    panel = best;
  }

  const r = panel.getBoundingClientRect();
  const scrollers = [...panel.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 2).length;
  const clipped = panel.scrollHeight > panel.clientHeight + 2;
  const panelScrolls = ["auto", "scroll"].includes(getComputedStyle(panel).overflowY);
  return {
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    viewport: [vw, vh],
    fits: r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1,
    // Content the panel clips must remain reachable: the panel itself or
    // a descendant has to be a scroll container.
    reachable: !clipped || panelScrolls || scrollers > 0,
    hOverflow: Math.max(0, document.documentElement.scrollWidth - vw),
    // Identity of the panel actually measured. Without this a probe that
    // measured the WRONG dialog still looks green, and the identical size
    // on every page is the only hint that something is off.
    id: {
      fresh: fresh.length,
      mounted: all.length - fresh.length,
      kind: panel.getAttribute("role"),
      head: (panel.textContent || "").replace(/\s+/g, " ").trim().slice(0, 44),
    },
  };
}

/**
 * Does the panel's PINNED chrome survive the body being scrolled to the end?
 *
 * This is the exact bug class `DialogBody`'s `min-h-0` exists to prevent: a
 * flex child with `overflow-y` refuses to shrink below its content, the
 * scroll region collapses back to the panel, and the footer is pushed past
 * the bottom edge with no way to reach it. Scroll regions and footers are
 * found by the classes the component system actually emits (`.pos-scroll` on
 * `DialogBody`), so overlays built by hand simply report `scrolled: false`
 * instead of being judged by a rule that does not apply to them.
 */
function footerPinned(sel) {
  const fresh = [...document.querySelectorAll(sel)].filter((d) => !d.hasAttribute("data-neu-mounted"));
  const panel = fresh[fresh.length - 1];
  if (!panel) return { scrolled: false };
  const body = panel.querySelector(".pos-scroll");
  if (!body) return { scrolled: false };
  const scrollable = body.scrollHeight > body.clientHeight + 2;
  body.scrollTop = body.scrollHeight;
  const pr = panel.getBoundingClientRect();
  const kids = [...panel.children];
  const fr = kids[kids.length - 1].getBoundingClientRect();
  return {
    scrolled: scrollable,
    footerBottom: Math.round(fr.bottom),
    panelBottom: Math.round(pr.bottom),
    inside: fr.bottom <= pr.bottom + 1 && fr.top >= pr.top - 1,
  };
}

/** Legacy light values still painted AFTER `.dark` is applied. */
function scanDark(lightOnly) {
  const TEXT = new Set(lightOnly.text);
  const BG = new Set(lightOnly.bg);
  const BORDER = new Set(lightOnly.border);
  const SKIP = new Set(["IMG", "SVG", "PATH", "CANVAS", "SCRIPT", "STYLE", "VIDEO", "DEFS"]);
  const hits = [];
  let scanned = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (SKIP.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    scanned++;
    if (TEXT.has(cs.color)) hits.push("text=" + cs.color + " @" + el.tagName);
    if (BG.has(cs.backgroundColor)) hits.push("bg=" + cs.backgroundColor + " @" + el.tagName);
    if (parseFloat(cs.borderTopWidth) > 0 && BORDER.has(cs.borderTopColor)) hits.push("border=" + cs.borderTopColor + " @" + el.tagName);
  }
  return { scanned, unique: [...new Set(hits)].slice(0, 8) };
}

/**
 * The keyboard contract of the open overlay, measured — not assumed.
 *
 * Two different contracts, and the caller applies the matching one so they
 * cannot be swapped by accident:
 *
 *   • `role="dialog"` / `alertdialog` — a MODAL. Focus has to move inside,
 *     Tab must not escape it, and closing must hand focus back to whatever
 *     opened it. A modal with no trap tells a screen reader the rest of the
 *     page is inert while the focus ring walks straight behind the scrim.
 *   • `role="menu"` / `listbox` — an ANCHORED popover. It must not STEAL
 *     focus: focus stays on the trigger or moves inside the panel, and never
 *     lands on <body>, which is how a keyboard user loses their place.
 */
function keyboardProbe(sel) {
  const fresh = [...document.querySelectorAll(sel)].filter((d) => !d.hasAttribute("data-neu-mounted"));
  const panel = fresh[fresh.length - 1];
  if (!panel) return { open: false };
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const items = [...panel.querySelectorAll(FOCUSABLE)];
  const active = document.activeElement;
  const label = (el) =>
    !el ? "none"
      : (el.getAttribute("aria-label") || el.getAttribute("title") ||
         (el.textContent || "").replace(/\s+/g, " ").trim() || el.tagName).slice(0, 40);
  /* `label` is for the LOG and is useless as an identity: every text field
     reports the bare string "INPUT", so "did Tab actually move focus?" was
     answered "no" for two different inputs and looked like a missing trap.
     The key is what the advance check compares. */
  const key = (el) => {
    if (!el) return "none";
    if (!panel.contains(el)) return "outside:" + el.tagName;
    return el.tagName +
      (el.getAttribute("name") ? "[" + el.getAttribute("name") + "]" : "") +
      (el.id ? "#" + el.id : "") + "@" + items.indexOf(el) +
      (el.getAttribute("placeholder") ? ":" + el.getAttribute("placeholder").slice(0, 16) : "");
  };
  return {
    open: true,
    kind: panel.getAttribute("role"),
    inside: !!active && panel.contains(active),
    onTrigger: !!window.__neuTrigger && active === window.__neuTrigger,
    triggerFocused: !!window.__neuTriggerFocused,
    focusables: items.length,
    active: label(active),
    activeKey: key(active),
  };
}

/**
 * Measure an overlay that is ALREADY OPEN, then dismiss it. Everything below
 * assumes the page is the one under test and the panel is the one that just
 * appeared.
 */
async function measureOpenOverlay(trigger, url, kind) {
  const sizes = [];
  // Only a MODAL is re-measured across every viewport: it is centred by the
  // layout, so "does it still fit at 375px" is a claim the app makes. An
  // ANCHORED overlay (menu / listbox) is offset from its trigger with plain
  // `absolute right-0` math that nothing re-runs on resize — asserting its
  // geometry after a viewport change would be asserting behaviour the app
  // never claimed, so it is measured where it was opened.
  const anchored = kind === "menu" || kind === "listbox";
  const viewports = anchored ? [[null, null, null]] : OVERLAY_VIEWPORTS;
  for (const [w, h, mobile] of viewports) {
    if (w !== null) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
      await sleep(400);
    }
    const m = await evalJs("(" + measureOverlay.toString() + ")(" + JSON.stringify(OVERLAY_SELECTOR) + ")");
    if (m) sizes.push({ at: m.viewport.join("x"), ...m });
    // The pinned-footer claim matters most where space is tightest, and the
    // metrics override is cleared right after this loop — so read it here.
    if (w === 375) sizes[sizes.length - 1].footer = await evalJs("(" + footerPinned.toString() + ")(" + JSON.stringify(OVERLAY_SELECTOR) + ")");
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(250);

  // ── the keyboard contract, read while the overlay is still open ──
  const kbOpen = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(OVERLAY_SELECTOR) + ")");
  let kbTab = null;
  if (kbOpen.open && kbOpen.focusables > 1) {
    await pressKey("Tab");
    await sleep(200);
    kbTab = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(OVERLAY_SELECTOR) + ")");
  }

  // A dialog is where the app's FORMS live, and those carry the states that
  // matter most: a submit button disabled while saving, the group-*/peer-*
  // affordances on a field row. None of it is reachable from the resting
  // page scan — at rest the dialog is not in the DOM at all — and the
  // dialogs only ever appear when a user opens one. So probe them here,
  // while the overlay is still open and before it is dismissed.
  const states = await probeExtraStates(DISABLED_STYLED);
  const focusLegacy = await evalJs("(" + legacyFocusTokens.toString() + ")()");

  // Close it again with a REAL Escape, so the dialog's own handler runs.
  await pressKey("Escape");
  await sleep(400);
  // "Closed" means no overlay that appeared after the stamp is still mounted
  // — checked per instance rather than by "is any overlay in the DOM", which
  // a permanently-mounted one (the library's own listboxes) would break.
  const closed = !(await evalJs(`!!document.querySelector(${JSON.stringify(NOT_STAMPED(OVERLAY_SELECTOR))})`));
  // `focusOnWhat` and `triggerGone` exist for triage: "focus went to an
  // INPUT" does not say WHICH input (the panel's own field? the page's search
  // box? a stale trigger?), and a detached trigger reference makes a
  // successful restore look like a failure.
  const focusAfter = await evalJs(`(() => {
    const t = window.__neuTrigger, a = document.activeElement;
    const name = (el) => el ? (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('name') || el.id || (el.textContent || '').replace(/\\s+/g, ' ').trim() || el.tagName).slice(0, 40) : 'none';
    return {
      returned: !!t && a === t,
      focusOn: a ? a.tagName : 'none',
      focusOnWhat: name(a),
      triggerGone: !t || !document.contains(t),
    };
  })()`);
  const keyboard = {
    ...kbOpen,
    afterTab: kbTab ? { inside: kbTab.inside, active: kbTab.active, activeKey: kbTab.activeKey } : null,
    advanced: kbTab ? kbTab.activeKey !== kbOpen.activeKey : null,
    ...focusAfter,
  };
  return { trigger, opened: true, closed, sizes, states, focusLegacy, keyboard, url };
}

/**
 * Click candidate `index` (skipping names in `seen`) and, if that opened a
 * dialog, measure it. Returns null when no candidates are left.
 */
async function tryOverlay(tried) {
  // Stamp whatever is already mounted BEFORE clicking, so "the dialog that
  // just opened" is identifiable by the absence of the stamp.
  await evalJs(MARK_MOUNTED(OVERLAY_SELECTOR));
  const before = await evalJs("location.pathname");
  // Always index 0: `tried` already removes the candidates this run has
  // clicked, so the list itself advances. Passing a growing index would
  // instead index into a list that SHRINKS as triggers are consumed, and
  // the second overlay of a page would never be reached at all.
  const name = await evalJs(
    "(" + clickOverlayTrigger.toString() + ")(" + JSON.stringify(OVERLAY_SELECTOR) + ", 0, " + JSON.stringify(tried) + ")"
  );
  if (!name) return null;
  await sleep(550);
  const after = await evalJs("location.pathname");
  if (after !== before) return { trigger: name, navigated: after, opened: false, sizes: [] };
  if (!(await evalJs(`!!document.querySelector(${JSON.stringify(NOT_STAMPED(OVERLAY_SELECTOR))})`))) {
    // Not every "Add …" button opens an overlay (some toggle an inline form),
    // and a stray click can leave a popover behind. Clear it before trying
    // the next candidate so the attempts stay independent.
    await pressKey("Escape");
    await sleep(250);
    return { trigger: name, opened: false, sizes: [] };
  }
  // The kind decides which keyboard contract applies and whether the panel is
  // re-measured across viewports, so read it off the live element.
  const kind = await evalJs(
    `(() => { const els = [...document.querySelectorAll(${JSON.stringify(NOT_STAMPED(OVERLAY_SELECTOR))})]; const el = els[els.length - 1]; return el ? el.getAttribute("role") : null; })()`
  );
  return measureOpenOverlay(name, after, kind);
}

/* ── anchored popovers ───────────────────────────────────────────────
   Menus and listboxes are the other half of "overlay layout", and the
   generic hunt above cannot reach them: their triggers are named "Export"
   (on the never-click list, because an export IS an action), "Currency", or
   nothing at all. Each is therefore opened by an explicitly named trigger.
   Opening a menu is not an action and the probe never clicks an ITEM, so
   this stays read-only.

   The panel is measured where it opens (a popover is anchored to its
   trigger, so "fits after an arbitrary resize" is not a claim the app makes)
   and then again at 375px, because a panel pinned to a trigger's END edge is
   exactly how a dropdown ends up off the side of a phone.

   `item` doubles as the identity check: a menu that opened the WRONG panel
   (the theme spec finding the notification bell, say) has a different role
   and a different kind of item, so it reports a mismatch instead of quietly
   measuring something plausible. */
const POPOVERS = [
  {
    name: "currency picker",
    page: "/dashboard",
    trigger: 'header button[aria-haspopup="listbox"]',
    panel: '[role="listbox"]',
    kind: "listbox",
    item: '[role="option"]',
  },
  {
    // First `aria-haspopup="menu"` in the header is the theme toggle; the
    // bell and the avatar follow it. The item kind is what proves it.
    name: "theme menu",
    page: "/dashboard",
    trigger: 'header button[aria-haspopup="menu"]',
    panel: '[role="menu"]',
    kind: "menu",
    item: '[role="menuitemradio"]',
  },
  {
    name: "export menu",
    page: "/reports/sales",
    trigger: 'main button[aria-haspopup="menu"]',
    panel: '[role="menu"]',
    kind: "menu",
    item: '[role="menuitem"]',
  },
];

/** Click the one trigger a spec names, the way a real mousedown would. */
function openPopover(trigger) {
  const el = document.querySelector(trigger);
  if (!el) return null;
  el.focus();
  el.click();
  window.__neuTrigger = el;
  window.__neuTriggerFocused = document.activeElement === el;
  return (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Role + item count + heading of the popover that appeared after the stamp. */
const POPOVER_IDENTITY = (panel, item) => `(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(panel)})];
  const fresh = all.filter((d) => !d.hasAttribute("data-neu-mounted"));
  const el = fresh[fresh.length - 1];
  if (!el) return null;
  return {
    kind: el.getAttribute("role"),
    items: el.querySelectorAll(${JSON.stringify(item)}).length,
    head: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40),
  };
})()`;

const FOCUS_AFTER_CLOSE =
  "(() => { const t = window.__neuTrigger, a = document.activeElement; " +
  "return { returned: !!t && a === t, focusOn: a ? a.tagName : 'none' }; })()";

async function probePopover(spec) {
  const result = { name: spec.name, kind: spec.kind, opened: false, sizes: [], identity: null, keyboard: null, arrow: null };
  await send("Page.navigate", { url: BASE + spec.page });
  if (!(await waitFor(`document.readyState === 'complete' && !!document.querySelector('main')`))) return result;
  await sleep(900);

  for (const [w, h] of [[null, null], [375, 667]]) {
    if (w) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: true });
      await sleep(450);
    }
    await evalJs(MARK_MOUNTED(OVERLAY_SELECTOR));
    const name = await evalJs("(" + openPopover.toString() + ")(" + JSON.stringify(spec.trigger) + ")");
    await sleep(420);
    if (!name) {
      if (w) await send("Emulation.clearDeviceMetricsOverride");
      return result;
    }
    result.opened = true;
    result.trigger = name;

    const m = await evalJs("(" + measureOverlay.toString() + ")(" + JSON.stringify(spec.panel) + ")");
    const id = await evalJs(POPOVER_IDENTITY(spec.panel, spec.item));

    if (!w) {
      // The keyboard contract, read while it is open. A popover must not trap
      // (that is the modal contract) but it must not dump focus on <body>
      // either, and the arrow keys have to walk the items.
      result.identity = id;
      const kb = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(spec.panel) + ")");
      result.keyboard = kb;
      if (kb.open && kb.focusables > 1) {
        await pressKey("ArrowDown");
        await sleep(200);
        const after = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(spec.panel) + ")");
        result.arrow = {
          before: kb.active,
          after: after.active,
          advanced: after.activeKey !== kb.activeKey,
          inside: after.inside === true,
        };
      }
    }

    await pressKey("Escape");
    await sleep(380);
    const closed = !(await evalJs("!!document.querySelector(" + JSON.stringify(NOT_STAMPED(spec.panel)) + ")"));
    const focusAfter = await evalJs(FOCUS_AFTER_CLOSE);
    result.sizes.push({
      at: m ? m.viewport.join("x") : "unknown",
      fits: m ? m.fits : null,
      hOverflow: m ? m.hOverflow : null,
      reachable: m ? m.reachable : null,
      rect: m ? m.rect.join(",") : null,
      closed,
      ...focusAfter,
    });
  }

  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(250);
  return result;
}

/* ── the image lightbox ──────────────────────────────────────────────
   It is a `role="dialog"` like the rest, but its trigger is a thumbnail
   (an image click, which no name-based hunt finds), and its ROOT is
   full-bleed by design — the frame inside is what must fit.

   Geometry is deliberately not asserted here: the seeded database has no
   product images, so there is nothing to size the frame, and measuring the
   close button instead would be the exact vacuous check this file exists to
   avoid. The cap that makes the frame safe is asserted statically in
   audit-neu-theme.mjs instead; what is asserted here is the behaviour, which
   is image-independent. */
const LIGHTBOX_TRIGGER = "main button.cursor-zoom-in";
const LIGHTBOX_PANEL = 'div.lightbox-root[role="dialog"]';

async function probeLightbox() {
  const result = { opened: false };
  await send("Page.navigate", { url: BASE + "/products" });
  if (!(await waitFor(`document.readyState === 'complete' && !!document.querySelector('main')`))) return result;
  await sleep(1000);
  await evalJs(MARK_MOUNTED(OVERLAY_SELECTOR));

  const name = await evalJs(
    "(() => { const el = document.querySelector(" + JSON.stringify(LIGHTBOX_TRIGGER) + "); " +
    "if (!el) return null; el.focus(); el.click(); window.__neuTrigger = el; " +
    "window.__neuTriggerFocused = document.activeElement === el; " +
    "return (el.getAttribute('title') || 'thumbnail').slice(0, 40); })()"
  );
  await sleep(600);
  if (!name) return result;
  result.opened = true;
  result.trigger = name;

  const kb = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(LIGHTBOX_PANEL) + ")");
  result.keyboard = kb;
  result.focusables = kb.open ? kb.focusables : 0;
  let tab = null;
  if (kb.open && kb.focusables > 1) {
    await pressKey("Tab");
    await sleep(200);
    const after = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(LIGHTBOX_PANEL) + ")");
    tab = { active: after.active, inside: after.inside, advanced: after.activeKey !== kb.activeKey };
  }
  result.tab = tab;

  await pressKey("Escape");
  await sleep(450);
  result.closed = !(await evalJs("!!document.querySelector(" + JSON.stringify(NOT_STAMPED(LIGHTBOX_PANEL)) + ")"));
  result.focusAfter = await evalJs(FOCUS_AFTER_CLOSE);
  return result;
}

/**
 * Up to `budget` overlays this page has not already yielded.
 *
 * `tried` is shared across pages AND records attempts that opened nothing,
 * so (a) an overlay reached from the shared header — the command palette,
 * the shortcuts modal — is measured once per run instead of identically
 * six times, and (b) a button that toggles an inline form rather than a
 * panel is never clicked twice.
 */
async function probeOverlays(budget, tried) {
  const found = [];
  for (let i = 0; i < 8 && found.length < budget; i++) {
    const r = await tryOverlay(tried);
    if (!r) break;
    tried.push(r.trigger);
    if (r.opened) found.push(r);
  }
  return found;
}

/** Flip `.dark`, scan for surviving light values, flip back. */
async function probeDarkMode() {
  await evalJs(NO_TRANSITION_ON);
  const result = await evalJs(`(() => {
    document.documentElement.classList.add('dark');
    const cs = getComputedStyle(document.body);
    return { bodyBg: cs.backgroundColor, bodyInk: cs.color };
  })()`);
  await sleep(350);
  const scan = await evalJs("(" + scanDark.toString() + ")(" + JSON.stringify(LIGHT_ONLY) + ")");
  await evalJs("document.documentElement.classList.remove('dark')");
  await evalJs(NO_TRANSITION_OFF);
  return { ...result, ...scan };
}

(async () => {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const PORT = 9500 + Math.floor(Math.random() * 300);

  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      if (res.ok) target = await res.json();
    } catch { /* not up yet */ }
    if (!target) await sleep(500);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("could not open CDP tab");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
      const text = (m.params.args ?? [])
        .map((a) => (typeof a.value === "string" ? a.value : a.description ?? ""))
        .join(" ")
        .slice(0, 600);
      if (text) cdpErrors.push(text);
    }
    if (m.method === "Runtime.exceptionThrown") {
      cdpErrors.push(
        String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "exception").slice(0, 600)
      );
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("CSS.enable");
  // Headless Chrome does not treat a programmatic focus as focus-visible
  // on its own; this makes the emulated focused state behave like a real
  // keyboard focus. CSS.forcePseudoState then does the per-element work.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // ── login through the UI, so cookies + Origin are handled by the app ──
  // Returns null on success, or a human-readable reason on failure: a
  // bare "could not log in" tells you nothing about WHERE it broke.
  const login = async () => {
    await send("Page.navigate", { url: BASE + "/login" });
    // The form must exist AND have been hydrated before it can be filled.
    // The server-rendered inputs are inert: fill one before React takes it
    // over and the controlled re-render re-asserts its empty state, which
    // surfaces only as the app's own "Invalid email address".
    const ready = await waitFor(
      `(() => {
        const fields = document.querySelectorAll('input[type=email], input[type=password]');
        if (fields.length < 2) return false;
        return [...fields].every((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$')));
      })()`
    );
    if (!ready) return "the login form never hydrated";
    // Fill through React's own value setter rather than focus() +
    // Input.insertText: the CDP typing path is racy against hydration too,
    // and when it loses the race nothing is typed at all. Dispatching
    // `input` is what React listens for, so the component's state updates
    // exactly as if a user typed.
    const fill = (sel, value) => evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value;
    })()`);
    let email = null, password = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      email = await fill("input[type=email]", "admin@elitepos.com");
      password = await fill("input[type=password]", "Admin@123");
      if (email === "admin@elitepos.com" && password === "Admin@123") break;
      await sleep(400);
    }
    if (email !== "admin@elitepos.com" || password !== "Admin@123") {
      return "the credential fields would not take their value (email=" + JSON.stringify(email) +
        ", password " + (password === "Admin@123" ? "set" : "NOT set") + ")";
    }
    const clicked = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /sign in|log in/i.test(x.textContent || ''));
      if (b) b.click();
      return !!b;
    })()`);
    if (!clicked) return "no button matching /sign in|log in/";
    if (await waitFor(`!location.pathname.startsWith('/login')`, 25000)) return null;
    const shown = await evalJs(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)`);
    return "still on /login; it says: " + JSON.stringify(shown);
  };

  const overlays = [];
  const triedTriggers = [];
  const stateTotals = { press: 0, disabled: 0, relational: 0 };
  const loginError = await login();
  if (loginError) throw new Error("could not log in at " + BASE + " — " + loginError);

  // The onboarding modal is shown ONCE per browser (localStorage), and this
  // audit always starts from a wiped profile — so left alone it is open over
  // every page in the run, and every overlay measurement has to fight it.
  // Its contract is "dismissible by Esc, ✕ or Get started", so dismiss it the
  // way a user would and then assert the stage is clear.
  const anyDialog = () => evalJs("!!document.querySelector('[role=\"dialog\"]')");
  for (let i = 0; i < 3 && (await anyDialog()); i++) { await pressKey("Escape"); await sleep(500); }
  check("setup: the one-time onboarding overlay is dismissed before scanning",
        await anyDialog(), false);

  // ── the mobile nav drawer ──
  // Measured on its own visit rather than hunted. It is the one overlay in the
  // app whose focus trap this codebase owns, and it is unreachable by the
  // generic probe three times over: its trigger is `md:hidden` (invisible at
  // the hunting width), it is permanently mounted and merely translated
  // off-screen rather than conditionally rendered (so "appeared after the
  // stamp" can never fire), and it only exists below the `md` breakpoint.
  {
    const DRAWER = 'aside[role="dialog"][aria-modal="true"]';
    await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
    const opened = await evalJs(
      `(() => {
         const btn = document.querySelector('header button[aria-expanded][aria-label]');
         if (!btn) return null;
         btn.focus(); btn.click();
         window.__neuTrigger = btn;
         window.__neuTriggerFocused = document.activeElement === btn;
         return btn.getAttribute("aria-label");
       })()`
    );
    await sleep(600);
    const m = await evalJs("(" + measureOverlay.toString() + ")(" + JSON.stringify(DRAWER) + ")");
    const kbOpen = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(DRAWER) + ")");
    let kbTab = null;
    if (kbOpen.open && kbOpen.focusables > 1) {
      await pressKey("Tab");
      await sleep(200);
      kbTab = await evalJs("(" + keyboardProbe.toString() + ")(" + JSON.stringify(DRAWER) + ")");
    }
    check("mobile drawer: the toggle is announced, and opens an aria-modal drawer",
          { label: opened, kind: m?.id?.kind, modal: true }, (v) => !!v.label && v.kind === "dialog");
    if (m) {
      check(`mobile drawer: fits ${m.viewport.join("x")} (panel=${m.rect.join(",")})`, m.fits, true);
      check("mobile drawer: adds no horizontal page overflow", m.hOverflow, (v) => v <= 1);
      check("mobile drawer: content taller than the drawer stays reachable", m.reachable, true);
    }
    check("mobile drawer: moves focus inside on open",
          { active: kbOpen.active, inside: kbOpen.inside }, (v) => v.inside === true);
    if (kbTab) {
      check(`mobile drawer: Tab stays inside the trap (${kbOpen.focusables} focusable)`,
            { active: kbTab.active, inside: kbTab.inside, advanced: kbTab.activeKey !== kbOpen.activeKey },
            (v) => v.inside === true && v.advanced === true);
    }
    await pressKey("Escape");
    await sleep(450);
    const after = await evalJs(
      `(() => {
         const d = document.querySelector(${JSON.stringify(DRAWER)});
         return { open: !!d && d.getBoundingClientRect().left > -1,
                  returned: document.activeElement === window.__neuTrigger,
                  on: document.activeElement ? document.activeElement.tagName : "none" };
       })()`
    );
    check("mobile drawer: Escape closes it", after.open, false);
    check("mobile drawer: hands focus back to its toggle on close",
          { returned: after.returned, focusOn: after.on }, (v) => v.returned === true);
    await send("Emulation.clearDeviceMetricsOverride");
    await sleep(300);
  }

  // ── the command palette's PHONE entry point ──
  // The ⌘K well in the bar is `md:flex`, so on a handset the palette had no
  // entry point at all: it existed, and was reachable only with a physical
  // keyboard. A trigger that is hidden above `md` is invisible to every other
  // probe in this file (they all run at desktop width), so it is measured here,
  // at the width where it is the only way in.
  {
    await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
    const opener = await evalJs(
      `(() => {
         const btns = Array.from(document.querySelectorAll('header button')).filter(
           (b) => b.getClientRects().length > 0 && !b.closest('[inert]')
         );
         const btn = btns.find((b) => /search/i.test(b.getAttribute('aria-label') || b.getAttribute('title') || ''));
         if (!btn) return { found: false, visible: btns.map((b) => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20)) };
         btn.focus(); btn.click();
         return { found: true, label: btn.getAttribute('aria-label') };
       })()`
    );
    check("palette: a control below `lg` opens the ⌘K palette (the well is lg-only)",
          opener, (v) => !!v && v.found === true);
    await sleep(500);
    const palette = await evalJs(
      `(() => {
         const d = document.querySelector('[role="dialog"][aria-modal="true"]');
         return { open: !!d, label: d ? d.getAttribute('aria-label') : null };
       })()`
    );
    check("palette: it opens as a labelled aria-modal dialog from that control",
          palette, (v) => !!v && v.open === true && !!v.label);
    await pressKey("Escape");
    await sleep(450);
    check("palette: Escape closes it again at phone width",
          await evalJs("!document.querySelector('[role=\"dialog\"]')"), true);
    await send("Emulation.clearDeviceMetricsOverride");
    await sleep(300);
  }

  // ── the anchored popovers ──
  // Menus and listboxes, opened by name because the additive-trigger hunt
  // cannot reach them (see POPOVERS).
  for (const spec of POPOVERS) {
    const p = await probePopover(spec);
    check(`popover: "${p.name}" opened from its trigger (${p.trigger ?? spec.trigger})`, p.opened, true);
    if (!p.opened) continue;
    check(`popover: "${p.name}" is the ${p.kind} that was opened (${p.identity?.items} items: ${p.identity?.head})`,
          p.identity, (v) => !!v && v.kind === p.kind && v.items >= 2);
    check(`popover: "${p.name}" fits the viewport at ${p.sizes.map((s) => s.at).join(", ")}`,
          p.sizes.map((s) => [s.at, s.fits, `panel=${s.rect}`, `vh=${s.hOverflow}`]),
          (v) => v.every((s) => s[1] === true));
    check(`popover: "${p.name}" adds no horizontal page overflow`,
          p.sizes.map((s) => [s.at, s.hOverflow]), (v) => v.every((s) => s[1] !== null && s[1] <= 1));
    check(`popover: "${p.name}" content taller than the panel stays reachable`,
          p.sizes.map((s) => [s.at, s.reachable]), (v) => v.every((s) => s[1] === true));
    check(`popover: "${p.name}" never dumps focus on <body> when it opens`,
          { active: p.keyboard?.active, inside: p.keyboard?.inside, onTrigger: p.keyboard?.onTrigger },
          (v) => v.inside === true || v.onTrigger === true);
    if (p.arrow) {
      check(`popover: "${p.name}" ArrowDown walks to another item`,
            p.arrow, (v) => v.advanced === true && v.inside === true);
    }
    check(`popover: "${p.name}" Escape closes it`,
          p.sizes.map((s) => [s.at, s.closed]), (v) => v.every((s) => s[1] === true));
    check(`popover: "${p.name}" hands focus back to its trigger on close`,
          p.sizes.map((s) => [s.at, s.returned, s.focusOn]), (v) => v.every((s) => s[1] === true));
  }

  // ── the image lightbox ──
  {
    const lb = await probeLightbox();
    check("lightbox: opens from a product thumbnail as a dialog",
          { opened: lb.opened, trigger: lb.trigger, kind: lb.keyboard?.kind },
          (v) => v.opened === true && v.kind === "dialog");
    if (lb.opened) {
      check("lightbox: moves focus inside on open",
            { active: lb.keyboard?.active, inside: lb.keyboard?.inside }, (v) => v.inside === true);
      if (lb.tab) {
        check(`lightbox: Tab stays inside the trap (${lb.focusables} focusable)`,
              lb.tab, (v) => v.inside === true && v.advanced === true);
      }
      // Same state guarantee the dialogs get: the lightbox chrome is a
      // documented exception in its COLOURS, not in its states.
      const lbStates = await probeExtraStates(DISABLED_STYLED);
      const lbFocus = await evalJs("(" + legacyFocusTokens.toString() + ")()");
      check("lightbox: no legacy colour in any state inside it",
            [...lbStates.press.legacy, ...lbStates.dis.legacy, ...lbStates.rel.legacy,
             ...lbFocus.map((tk) => "legacy focus token " + tk)].slice(0, 6),
            (v) => v.length === 0);
      check("lightbox: Escape closes it", lb.closed, true);
      if (lb.keyboard?.triggerFocused) {
        check("lightbox: hands focus back to the thumbnail on close",
              lb.focusAfter, (v) => v.returned === true);
      }
    }
  }

  for (const page of PAGES) {
    await send("Page.navigate", { url: BASE + page });
    const ok = await waitFor(`document.readyState === 'complete' && !!document.querySelector('main')`);
    if (!ok) { check(`${page} renders`, false, true); continue; }
    await sleep(900); // let client-side data settle

    const s = await evalJs(SCAN(LEGACY));
    check(`${page}: page surface is --neu-bg`, s.bodyBg, "rgb(230, 236, 240)");
    check(`${page}: body ink is a neu token`, s.bodyInk, (v) => ["rgb(51, 65, 85)", "rgb(71, 85, 105)"].includes(v));
    check(`${page}: no legacy surface colour in the DOM (${s.scanned} els)`, s.unique, (v) => v.length === 0);
    const equalPair = (v) => { const [a, b] = v.split("/"); return a === b; };
    if (s.sunkenExact) {
      check(`${page}: .bg-neu-sunken elements resolve --neu-sunken`,
            s.sunkenExactOk === s.sunkenExact ? `${s.sunkenExactOk}/${s.sunkenExact}` : s.samples,
            (v) => typeof v === "string" && /^(\d+)\/\1$/.test(v));
    }

    // ── non-resting states ──
    const st = await probeStates();
    check(`${page}: :hover adds no legacy colour (${st.hoverProbed}/${st.hoverTotal} probed)`,
          st.hoverLegacy, (v) => v.length === 0);
    if (st.hoverProbed) {
      check(`${page}: forced :hover changes a colour on every affordance`,
            { changed: st.hoverChanged, probed: st.hoverProbed, stuck: st.hoverStuck },
            (v) => v.changed === v.probed);
    }
    check(`${page}: no legacy focus-indicator utility left in the DOM`,
          st.legacyFocus, (v) => v.length === 0);
    check(`${page}: focused .neu-focus paints --neu-focus-ring`,
          { ringed: st.focusRinged, probed: st.focusProbed, ring: st.ringRgb },
          (v) => v.probed === 0 || v.ringed === v.probed);
    check(`${page}: :focus adds no legacy colour (${st.focusProbed}/${st.focusTotal} probed)`,
          st.focusLegacy, (v) => v.length === 0);

    // ── press / disabled / relational ──
    const st2 = await probeExtraStates(DISABLED_STYLED);
    stateTotals.press += st2.press.probed;
    stateTotals.disabled += st2.dis.probed;
    stateTotals.relational += st2.rel.probed;
    if (st2.press.probed) {
      check(`${page}: forced :active changes every press affordance (${st2.press.probed}/${st2.press.total})`,
            { changed: st2.press.changed, probed: st2.press.probed, stuck: st2.press.stuck },
            (v) => v.changed === v.probed);
    }
    check(`${page}: :active adds no legacy colour`, st2.press.legacy, (v) => v.length === 0);
    if (st2.dis.probed) {
      check(`${page}: every disabled-styled control paints a disabled state (${st2.dis.probed}/${st2.dis.total})`,
            { changed: st2.dis.changed, probed: st2.dis.probed, stuck: st2.dis.stuck },
            (v) => v.changed === v.probed);
    }
    check(`${page}: a disabled control is never invisible`, st2.dis.invisible, (v) => v.length === 0);
    check(`${page}: :disabled adds no legacy colour`, st2.dis.legacy, (v) => v.length === 0);
    if (st2.rel.total) {
      check(`${page}: group-*/peer-* affordances paint their target (${st2.rel.probed}/${st2.rel.total})`,
            { changed: st2.rel.changed, probed: st2.rel.probed, stuck: st2.rel.stuck },
            (v) => v.changed === v.probed);
    }
    check(`${page}: every group-*/peer-* utility has its marker class in the DOM`,
          st2.rel.orphan, (v) => v.length === 0);
    check(`${page}: relational states add no legacy colour`, st2.rel.legacy, (v) => v.length === 0);

    // ── dark mode ──
    // Light-mode tokens must not survive the flip. Asserted positively
    // against the light VALUES (not the legacy palette), because in dark
    // mode some legacy light values legitimately collide (see SCAN).
    const dk = await probeDarkMode();
    check(`${page}: dark surface is the dark --neu-bg`, dk.bodyBg, "rgb(30, 41, 59)");
    check(`${page}: dark body ink is the dark --neu-text-primary`, dk.bodyInk, "rgb(241, 245, 249)");
    check(`${page}: no LIGHT token value survives in dark mode (${dk.scanned} els)`,
          dk.unique, (v) => v.length === 0);

    // ── overlay layout ──
    // Budget 2: the page's own dialog plus at most one more. Shared header
    // overlays (command palette, shortcuts) are only measured once per run,
    // so a page whose first candidate is the shared chrome still reaches its
    // own dialog on the next attempt.
    for (const ov of await probeOverlays(2, triedTriggers)) {
      overlays.push({ page, ov });
      if (!ov.opened) continue;
      check(`${page}: "${ov.trigger}" overlay fits the viewport at ${ov.sizes.map((s) => s.at).join(", ")} (on ${ov.url})`,
            ov.sizes.map((s) => [s.at, s.fits, `panel=${s.rect.join(",")}`, `viewport=${s.viewport.join("x")}`]),
            (v) => v.every((s) => s[1]));
      check(`${page}: "${ov.trigger}" overlay adds no horizontal page overflow`,
            ov.sizes.map((s) => [s.at, s.hOverflow]), (v) => v.every((s) => s[1] <= 1));
      check(`${page}: "${ov.trigger}" content taller than the panel stays reachable`,
            ov.sizes.map((s) => [s.at, s.reachable]), (v) => v.every((s) => s[1]));
      check(`${page}: "${ov.trigger}" is the overlay that was clicked (${ov.sizes[0]?.id?.head})`,
            ov.sizes[0]?.id,
            (v) => v && v.fresh === 1 && v.mounted === 0);
      const pinned = ov.sizes.find((s) => s.footer?.scrolled)?.footer;
      if (pinned) {
        check(`${page}: "${ov.trigger}" footer stays inside the panel once the body is scrolled`,
              { footerBottom: pinned.footerBottom, panelBottom: pinned.panelBottom, inside: pinned.inside },
              (v) => v.inside);
      }
      check(`${page}: Escape closes "${ov.trigger}"`, ov.closed, true);

      // ── the keyboard contract ──
      // Geometry alone cannot tell a usable overlay from a keyboard trap with
      // no way out, or from a popover that silently dumps focus on <body>.
      const kb = ov.keyboard;
      if (kb?.open) {
        const modal = kb.kind === "dialog" || kb.kind === "alertdialog";
        if (modal) {
          // The contract the app CLAIMS by putting `aria-modal` on the panel.
          check(`${page}: "${ov.trigger}" (${kb.kind}) moves focus inside on open`,
                { active: kb.active, inside: kb.inside }, (v) => v.inside === true);
          if (kb.afterTab) {
            check(`${page}: "${ov.trigger}" keeps Tab inside the panel (focus trap, ${kb.focusables} focusable)`,
                  { active: kb.afterTab.active, inside: kb.afterTab.inside, advanced: kb.advanced },
                  (v) => v.inside === true && v.advanced === true);
          }
        } else {
          // An anchored popover must not STEAL focus: on the trigger or inside
          // the panel, never on <body>.
          check(`${page}: "${ov.trigger}" (${kb.kind}) does not steal focus when it opens`,
                { active: kb.active, inside: kb.inside, onTrigger: kb.onTrigger, triggerFocused: kb.triggerFocused },
                (v) => !v.triggerFocused || v.inside === true || v.onTrigger === true);
        }
        // Only meaningful when the trigger could hold focus at all: the probe
        // clicks programmatically, and a non-focusable trigger legitimately
        // leaves focus on <body>.
        if (kb.triggerFocused) {
          check(`${page}: "${ov.trigger}" hands focus back to its trigger on close`,
                { returned: kb.returned, focusOn: kb.focusOn, focusOnWhat: kb.focusOnWhat, triggerGone: kb.triggerGone },
                (v) => v.returned === true);
        }
      }

      // Same guarantees as the page scan, asserted against the dialog's own
      // subtree — the resting scan proves the pages, this proves the modals.
      check(`${page}: no legacy colour in any state inside "${ov.trigger}"`,
            [...ov.states.press.legacy, ...ov.states.dis.legacy, ...ov.states.rel.legacy,
             ...ov.focusLegacy.map((t) => "legacy focus token " + t)].slice(0, 6),
            (v) => v.length === 0);
      check(`${page}: every group-*/peer-* inside "${ov.trigger}" has its marker class`,
            ov.states.rel.orphan, (v) => v.length === 0);
      check(`${page}: every state affordance inside "${ov.trigger}" paints`,
            {
              press: ov.states.press.changed + "/" + ov.states.press.probed,
              disabled: ov.states.dis.changed + "/" + ov.states.dis.probed,
              relational: ov.states.rel.changed + "/" + ov.states.rel.probed,
              stuck: [...ov.states.press.stuck, ...ov.states.dis.stuck, ...ov.states.rel.stuck].slice(0, 4),
            },
            (v) =>
              ov.states.press.changed === ov.states.press.probed &&
              ov.states.dis.changed === ov.states.dis.probed &&
              ov.states.rel.changed === ov.states.rel.probed);
    }
  }

  // The overlay probe is only meaningful if it actually opened something ...
  const opened = overlays.filter((o) => o.ov && o.ov.opened);
  check("overlay layout: at least one real overlay was measured",
        { opened: opened.map((o) => `${o.page}:${o.ov.trigger}`) }, (v) => v.opened.length > 0);
  // ...and only trustworthy if measuring the overlay did not navigate away
  // from the page under test (see clickOverlayTrigger).
  check("overlay layout: no probe click navigated away from its page",
        overlays.filter((o) => o.ov && o.ov.navigated).map((o) => `${o.page}:${o.ov.trigger} -> ${o.ov.navigated}`),
        (v) => v.length === 0);

  // ── the shared chrome at every width it is used at ──
  // The header is the one surface on every page, and a RESTING page was only
  // ever measured at desktop width: the overlay probes do check page overflow
  // at 375/768, but only while an overlay is open. A bar that fits at 1440 and
  // widens the document at 375 is precisely the regression a shared header
  // invites, so the chrome is measured at both small widths with nothing open.
  {
    // Four widths, because the shell's degradation ladder has four bands —
    // 768–1023 is the tightest of them (the rail takes 260px of a 768px
    // screen), and 1024–1279 is where the wide search well comes back.
    const SHELL_WIDTHS = [[375, 667, true], [768, 1024, true], [1024, 768, false], [1440, 900, false]];
    const headerOverflow = [];
    const pageOverflow = [];
    const notRendered = [];
    for (const page of PAGES) {
      for (const [w, h, mobile] of SHELL_WIDTHS) {
        await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
        cdpErrors.length = 0; // attribute the collected errors to this navigation only
        await send("Page.navigate", { url: BASE + page });
        // The pathname guard keeps the wait honest across navigations:
        // waitFor can observe the OLD document (complete, still holding its
        // header) in the gap before the new document commits, and the
        // measurement below would then run against a header that is about
        // to be torn down (null crash).
        const ok = await waitFor(
          `document.readyState === 'complete' && !!document.querySelector('header') &&
           location.pathname === ${JSON.stringify(page)}`
        );
        if (!ok) {
          // Name the culprit instead of leaving "not rendered" to bisect:
          // is the header actually missing, or is the load event stuck on
          // some subresource while the shell is already up?
          const why = await evalJs(
            `(() => ({ rs: document.readyState, header: !!document.querySelector('header'),
               path: location.pathname,
               errOverlay: !!document.querySelector('nextjs-portal'),
               bodyKids: document.body.children.length,
               pending: performance.getEntriesByType('resource').filter((r) => !r.responseEnd)
                 .map((r) => r.name.split('/').slice(-1)[0].slice(0, 48)).slice(0, 4) }))()`
          ).catch(() => null);
          notRendered.push(
            `${page}@${w}: no ready header after 20s — ${JSON.stringify(why)}\n  console(${cdpErrors.length}): ${cdpErrors.slice(0, 2).join("\n  ")}`
          );
          continue;
        }
        await sleep(700);
        const m = await evalJs(
          `(() => {
             const head = document.querySelector('header');
             if (!head) return { header: 0, past: 0, page: 0, box: [], parts: [], cluster: null, spill: [] };
             const doc = document.documentElement;
             const box = head.getBoundingClientRect();
             const spill = Array.from(head.querySelectorAll('*'))
               .filter((el) => el.getBoundingClientRect().right > box.right + 1)
               .slice(0, 3)
               .map((el) => ({
                 tag: el.tagName.toLowerCase(),
                 cls: String(el.className).slice(0, 46),
                 right: Math.round(el.getBoundingClientRect().right),
               }));
             const w = (el) => Math.round(el.getBoundingClientRect().width);
             const describe = (el) =>
               el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(-1)[0].slice(0, 16) + ':' + w(el);
             const parts = Array.from(head.children).map(describe);
             const cluster = head.querySelector('.ms-auto');
             return {
               header: Math.max(0, head.scrollWidth - head.clientWidth),
               past: Math.max(0, Math.round(box.right) - doc.clientWidth),
               page: Math.max(0, doc.scrollWidth - doc.clientWidth),
               box: [Math.round(box.left), Math.round(box.right)],
               parts,
               cluster: cluster ? Array.from(cluster.children).map(describe) : null,
               spill,
             };
           })()`
        );
        if (m.header > 1 || m.past > 1)
          headerOverflow.push(
            `${page}@${w}: scroll+${m.header} box=${m.box} parts=${JSON.stringify(m.parts)} cluster=${JSON.stringify(m.cluster)}`
          );
        if (m.page > 1) pageOverflow.push(`${page}@${w}: +${m.page}px`);
      }
    }
    await send("Emulation.clearDeviceMetricsOverride");
    check("shell: the header fits at 375 / 768 / 1024 / 1440 with nothing open",
          notRendered.length ? notRendered.map((p) => `not rendered: ${p}`) : headerOverflow,
          (v) => v.length === 0);
    check("shell: the resting page adds no horizontal overflow at any width",
          pageOverflow.slice(0, 8), (v) => v.length === 0);
  }

  // ── the rail's own ladder ──
  // Below `lg` the rail is ICON-ONLY by rule, not by preference: that 188px is
  // what lets the bar keep every control at 768, and it is a behaviour no
  // static check can confirm (the classes are there either way — whether they
  // resolve is a rendering question).
  const railWidth = async (w, h, mobile) => {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await send("Page.navigate", { url: BASE + "/products" });
    await waitFor("document.readyState === 'complete' && !!document.querySelector('main table')");
    await sleep(800);
    return evalJs(
      `(() => {
         const rail = document.querySelectorAll('aside')[0];
         const box = rail.getBoundingClientRect();
         const labels = Array.from(rail.querySelectorAll('nav a span')).filter((s) => s.className.includes('truncate'));
         const shown = labels.filter((s) => s.getClientRects().length > 0).length;
         /* The "New Sale" control is outside <nav>, so the label count above
            says nothing about it: it has to stay REACHABLE when the rail is
            icon-only, just with its text off. */
         const cta = rail.querySelector('a[href="/pos"]');
         const ctaLabel = cta ? cta.querySelector('span') : null;
         return {
           isRail: String(rail.className).includes('md:flex'),
           width: Math.round(box.width),
           labelsShown: shown,
           labels: labels.length,
           cta: !!cta && cta.getClientRects().length > 0,
           ctaText: !!ctaLabel && ctaLabel.getClientRects().length > 0,
           ctaWidth: cta ? Math.round(cta.getBoundingClientRect().width) : null,
         };
       })()`
    );
  };
  {
    const narrow = await railWidth(768, 1024, true);
    check("rail: below `lg` it is icon-only, whatever the preference says",
          narrow, (v) => v.isRail === true && v.width === 72 && v.labels > 0 && v.labelsShown === 0);
    check("rail: the primary action survives the icon form (text off, control reachable)",
          { cta: narrow.cta, ctaText: narrow.ctaText, ctaWidth: narrow.ctaWidth },
          (v) => v.cta === true && v.ctaText === false && v.ctaWidth > 24);
    const wide = await railWidth(1440, 900, false);
    check("rail: at `lg`+ it is the labelled rail again",
          wide, (v) => v.isRail === true && v.width === 260 && v.labelsShown === v.labels && v.labels > 0);
    check("rail: and the primary action is labelled there",
          { cta: wide.cta, ctaText: wide.ctaText }, (v) => v.cta === true && v.ctaText === true);
  }

  // ── collapsing the rail must GIVE the room to the content ──
  // The rail's width is content real estate: collapsed, 188px come back, and a
  // measure that did not move with it would leave the freed space as margin.
  {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: BASE + "/products" });
    await waitFor("document.readyState === 'complete' && !!document.querySelector('main table')");
    await sleep(900);
    const measure = `(() => {
      const main = document.querySelector('main');
      const inner = main.firstElementChild;
      const table = main.querySelector('table');
      const card = table ? table.closest('div, section') : null;
      return {
        main: Math.round(main.getBoundingClientRect().width),
        inner: Math.round(inner.getBoundingClientRect().width),
        table: table ? Math.round(table.getBoundingClientRect().width) : null,
        card: card ? Math.round(card.getBoundingClientRect().width) : null,
      };
    })()`;
    const before = await evalJs(measure);
    const toggled = await evalJs(
      `(() => {
         const btn = Array.from(document.querySelectorAll('aside button')).find((b) =>
           /collapse|expand/i.test(b.getAttribute('aria-label') || '')
         );
         if (!btn) return null;
         btn.click();
         return btn.getAttribute('aria-label');
       })()`
    );
    await sleep(700);
    const after = await evalJs(measure);
    check(`rail: collapsing it hands the freed width to the content (${toggled})`,
          { main: [before.main, after.main], inner: [before.inner, after.inner], table: [before.table, after.table] },
          (v) => v.inner[1] - v.inner[0] >= 150 && v.main[1] > v.main[0]);
    check("rail: a table inside the content actually widens with it",
          { table: [before.table, after.table], card: [before.card, after.card] },
          (v) => v.table[0] === null || v.table[1] - v.table[0] >= 100);
    // Restore, so nothing after this block inherits a collapsed rail.
    await evalJs(
      `(() => {
         const btn = Array.from(document.querySelectorAll('aside button')).find((b) =>
           /collapse|expand/i.test(b.getAttribute('aria-label') || '')
         );
         if (btn) btn.click();
         return true;
       })()`
    );
    await sleep(500);
    const restored = await evalJs(measure);
    check("rail: expanding it again restores the narrower measure",
          { inner: [before.inner, restored.inner] }, (v) => Math.abs(v.inner[1] - v.inner[0]) <= 2);
  }

  // ── the clock's responsive form ──
  // A dial with no readout tells you nothing at a glance; a readout with no
  // dial costs 64px. So the widget swaps rather than shrinks, and the value it
  // states to assistive tech has to survive the swap.
  {
    const clockAt = async (w, h, mobile) => {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
      await send("Page.navigate", { url: BASE + "/dashboard" });
      await waitFor("document.readyState === 'complete' && !!document.querySelector('header')");
      await sleep(900);
      return evalJs(
        `(() => {
           const group = document.querySelector('header [role="group"][aria-label]');
           if (!group) return null;
           const dial = group.querySelector('svg[viewBox="0 0 44 44"]');
           const compact = Array.from(group.querySelectorAll('div')).find((d) => d.className.includes('xl:hidden'));
           return {
             label: (group.getAttribute('aria-label') || '').slice(0, 60),
             dial: !!dial && dial.getClientRects().length > 0,
             compact: !!compact && compact.getClientRects().length > 0,
             text: (compact ? compact.textContent : '').trim().slice(0, 12),
           };
         })()`
      );
    };
    const mid = await clockAt(768, 1024, true);
    check("clock: below `xl` it is the compact readout (no dial, real time)",
          mid, (v) => !!v && v.dial === false && v.compact === true && /\d/.test(v.text));
    const big = await clockAt(1440, 900, false);
    check("clock: at `xl`+ it is the dial + the full readout",
          big, (v) => !!v && v.dial === true && v.compact === false);
    check("clock: it states the time in words at every width",
          { mid: mid?.label, big: big?.label },
          (v) => !!v.mid && /\d/.test(v.mid) && !!v.big && /\d/.test(v.big));
    await send("Emulation.clearDeviceMetricsOverride");
  }

  // ── a keyboard-only pass over the shell ──
  // Not "does each control have a name" (that is static) but "can a keyboard
  // user get from the top of the document to the content at all, and does every
  // stop on the way have something to announce". The walk stops at `main`:
  // past that point the order belongs to each page, not to the shell.
  {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: BASE + "/products" });
    await waitFor("document.readyState === 'complete' && !!document.querySelector('main table')");
    await sleep(900);

    // 1. the skip link is the first stop, and it lands focus in the content
    await pressKey("Tab");
    const first = await evalJs(
      `(() => {
         const el = document.activeElement;
         return {
           tag: el ? el.tagName.toLowerCase() : null,
           name: el ? (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) : null,
           href: el ? el.getAttribute('href') : null,
         };
       })()`
    );
    check("keyboard: the first Tab stop is the skip link",
          first, (v) => v.tag === "a" && v.href === "#main-content" && /skip/i.test(v.name || ""));
    await pressKey("Enter");
    await sleep(300);
    const landed = await evalJs(
      `(() => {
         const el = document.activeElement;
         return { id: el ? el.id : null, tag: el ? el.tagName.toLowerCase() : null };
       })()`
    );
    check("keyboard: activating it moves focus into <main> (not just the hash)",
          landed, (v) => v.id === "main-content" && v.tag === "main");

    // 2. the walk itself: every stop named, nothing from the closed drawer
    await send("Page.navigate", { url: BASE + "/products" });
    await waitFor("document.readyState === 'complete' && !!document.querySelector('main table')");
    await sleep(900);
    const stops = [];
    let reachedMain = false;
    for (let i = 0; i < 45; i++) {
      await pressKey("Tab");
      const s = await evalJs(
        `(() => {
           const el = document.activeElement;
           if (!el || el === document.body) return { end: true };
           return {
             tag: el.tagName.toLowerCase(),
             name: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 34),
             named: !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
                       (el.textContent || '').trim() || el.getAttribute('title')),
             drawer: !!el.closest('[inert]') || !!el.closest('aside[aria-hidden="true"]'),
             main: !!el.closest('main'),
           };
         })()`
      );
      if (s.end) break;
      stops.push(s);
      if (s.main) { reachedMain = true; break; }
    }
    check(`keyboard: the shell is walkable from the top to the content (${stops.length} stops)`,
          { stops: stops.length, reachedMain }, (v) => v.stops >= 10 && v.reachedMain === true);
    check("keyboard: every stop on the way has a name to announce",
          stops.filter((s) => !s.named).slice(0, 5), (v) => v.length === 0);
    check("keyboard: nothing in the CLOSED drawer is reachable",
          stops.filter((s) => s.drawer).slice(0, 5), (v) => v.length === 0);
    check("keyboard: the walk visits the rail before the bar",
          stops.findIndex((s) => s.tag === "a") < stops.findIndex((s) => s.name && /search/i.test(s.name)),
          (v) => v === true);

    // 3. and the walk continues THROUGH the page: past `main` the order is the
    //    page's own, and an invisible or unnamed stop in there is just as
    //    broken as one in the chrome.
    const pageStops = [];
    for (let i = 0; i < 60; i++) {
      await pressKey("Tab");
      const s = await evalJs(
        `(() => {
           const el = document.activeElement;
           if (!el || el === document.body) return { end: true };
           const cs = getComputedStyle(el);
           /* A field is named by its placeholder too: the accessible-name
              algo lists it as a last-resort text alternative, and every
              browser exposes it. Buttons have no such fallback. */
           const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
           const same = el === window.__neuWalkPrev;
           window.__neuWalkPrev = el;
           return {
             tag: el.tagName.toLowerCase(),
             cls: String(el.className).split(' ').slice(-1)[0].slice(0, 22),
             name: (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '')).trim().slice(0, 30),
             named: !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
                       (el.textContent || '').trim() || el.getAttribute('title') ||
                       (field && el.getAttribute('placeholder'))),
             visible: el.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
             hiddenAncestor: !!el.closest('[inert]') || !!el.closest('[aria-hidden="true"]'),
             same,
           };
         })()`
      );
      if (s.end) break;
      pageStops.push(s);
    }
    check(`keyboard: the page's own tab order is walkable (${pageStops.length} stops after main)`,
          pageStops.length, (v) => v >= 10);
    check("keyboard: no page stop is invisible, unnamed, or inside an aria-hidden subtree",
          pageStops
            .filter((s) => !s.visible || !s.named || s.hiddenAncestor)
            .map((s) => `${s.tag}.${s.cls} vis=${s.visible} named=${s.named} hidden=${s.hiddenAncestor}`)
            .slice(0, 8),
          (v) => v.length === 0);
    check("keyboard: Tab advances at every step (no stuck focus)",
          pageStops.filter((s) => s.same).map((s) => `${s.tag}.${s.cls}`).slice(0, 4),
          (v) => v.length === 0);
  }

  // ── the bar lifts once there is content under it ──
  // A lid, not a floating card: flush at rest, and a downward-only shadow the
  // moment the page scrolls beneath it.
  {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: BASE + "/products" });
    await waitFor("document.readyState === 'complete' && !!document.querySelector('main table')");
    await sleep(900);
    const shadow = () => evalJs("getComputedStyle(document.querySelector('header')).boxShadow");
    const rest = await shadow();
    await evalJs(
      `(() => {
         const main = document.querySelector('main');
         const pad = document.createElement('div');
         pad.id = 'neu-scroll-probe';
         pad.style.height = '1600px';
         main.appendChild(pad);
         main.scrollTop = 500;
         return main.scrollTop;
       })()`
    );
    await sleep(500);
    const lifted = await shadow();
    await evalJs(
      `(() => {
         const main = document.querySelector('main');
         main.scrollTop = 0;
         const pad = document.getElementById('neu-scroll-probe');
         if (pad) pad.remove();
         return true;
       })()`
    );
    await sleep(400);
    const back = await shadow();
    check("navbar: it is flush at rest and lifts when the content scrolls under it",
          { rest, lifted, back },
          (v) => v.rest === "none" && v.lifted !== "none" && v.back === "none");
  }

  // ── density ──
  // The densest surfaces in the app are tables. Density there is not "smaller"
  // — it is UNIFORM: ragged rows are what makes a table look assembled rather
  // than designed, and a row that outgrows its siblings hides content behind a
  // taller scroll.
  {
    // Every page that renders a table, because row-height raggedness is
    // content-driven: it shows up on whichever page happens to have an
    // optional second line, not on the page you happened to measure.
    const DENSE = [
      ["/products", "main table"],
      ["/inventory", "main table"],
      ["/orders", "main table"],
      ["/customers", "main table"],
      ["/suppliers", "main table"],
      ["/refunds", "main table"],
      ["/purchase-orders", "main table"],
      ["/settings/audit-log", "main table"],
    ];
    const report = [];
    const ragged = [];
    const outOfBand = [];
    for (const [page, sel] of DENSE) {
      await send("Page.navigate", { url: BASE + page });
      await waitFor(`document.readyState === 'complete' && !!document.querySelector('${sel}')`);
      await sleep(900);
      const m = await evalJs(
        `(() => {
           const table = document.querySelector(${JSON.stringify(sel)});
           /* Placeholder rows — a colspan filler (skeleton / empty cell) or an
              EmptyState rendered inside the table — are not data rows: their
              height is the placeholder's padding, not a row's. Excluding them
              keeps the band check about DATA uniformity. */
           const isDataRow = (r) =>
             r.getClientRects().length > 0 &&
             !r.querySelector('[colspan]') &&
             !r.querySelector('.neu-empty-title');
           const rows = Array.from(table.querySelectorAll('tbody tr'))
             .filter(isDataRow)
             .map((r) => Math.round(r.getBoundingClientRect().height));
           const chip = document.querySelector('.filter-chip, .chip-btn');
           const bar = chip ? chip.parentElement : null;
           /* Why are they different heights? Report the tallest cell of the
              tallest and the shortest row — that names the culprit instead of
              leaving the next reader to bisect the markup by hand. */
           const all = Array.from(table.querySelectorAll('tbody tr')).filter(isDataRow);
           const describe = (row) => {
             if (!row) return null;
             const cells = Array.from(row.children).map(
               (td) => (String(td.className).split(' ').find((c) => c && c !== 'inv-td' && c !== 'px-3' && c !== 'px-4') || td.tagName.toLowerCase()) +
                      ':' + Math.round(td.getBoundingClientRect().height)
             );
             return { h: Math.round(row.getBoundingClientRect().height), cells };
           };
           const tallest = all.slice().sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
           const shortest = all.slice().sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
           return {
             rows: rows.length,
             heights: Array.from(new Set(rows)).sort((a, b) => a - b),
             min: rows.length ? Math.min(...rows) : null,
             max: rows.length ? Math.max(...rows) : null,
             bar: bar ? Math.round(bar.getBoundingClientRect().height) : null,
             tallest: describe(tallest),
             shortest: describe(shortest),
           };
         })()`
      );
      report.push(
        `${page}: ${m.rows} rows ${m.min}–${m.max}px, toolbar ${m.bar ?? "—"}px, ` +
        `tallest ${JSON.stringify(m.tallest)}, shortest ${JSON.stringify(m.shortest)}`
      );
      if (m.rows >= 3 && m.max - m.min > 8) ragged.push(`${page}: ${m.min}–${m.max}`);
      if (m.min !== null && (m.min < 36 || m.max > 76)) outOfBand.push(`${page}: ${m.min}–${m.max}`);
    }
    check(`density: table rows are uniform (${report.join(" | ")})`, ragged, (v) => v.length === 0);
    check("density: row heights stay in the 36–76px band", outOfBand, (v) => v.length === 0);
  }

  // ── the same shell in Urdu (RTL) ──
  // `dir` flips to rtl for Urdu, which turns every physical-direction utility in
  // the shell into a latent bug: a rail pinned to `left-0`, a drawer pushed
  // `-translate-x-full` (i.e. INTO the viewport in RTL — a full-height overlay
  // nobody opened), a toast stack anchored to `right-4`. Driven through the real
  // language toggle, not by writing `dir` by hand.
  {
    const setLocale = async (target) => {
      await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: BASE + "/products" });
      await waitFor("document.readyState === 'complete' && !!document.querySelector('header')");
      await sleep(900);
      return evalJs(
        `(() => {
           const want = ${JSON.stringify(target)};
           const btn = Array.from(document.querySelectorAll('header button')).find((b) => {
             const label = b.getAttribute('aria-label') || '';
             const text = (b.textContent || '').trim();
             return /language|زبان/i.test(label) || text === (want === 'ur' ? 'اردو' : 'EN');
           });
           if (!btn) return null;
           btn.click();
           return (btn.textContent || '').trim();
         })()`
      );
    };
    const flipped = await setLocale("ur");
    await sleep(900);
    const rtl = await evalJs(
      `(() => {
         const doc = document.documentElement;
         const rail = document.querySelectorAll('aside')[0];
         const main = document.querySelector('main');
         const header = document.querySelector('header');
         /* The first labelled control that is actually RENDERED: the mobile
            nav toggle is md:hidden, i.e. a 0x0 box at the origin at 1440. */
         const menu = Array.from(header.querySelectorAll('button[aria-label]'))
           .find((b) => b.getClientRects().length > 0);
         const cluster = header.querySelector('.ms-auto');
         const clock = header.querySelector('[role="group"][aria-label]');
         const readout = clock ? clock.querySelector('[dir="ltr"]') : null;
         return {
           dir: doc.dir,
           overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
           railLeft: Math.round(rail.getBoundingClientRect().left),
           railWidth: Math.round(rail.getBoundingClientRect().width),
           mainRight: Math.round(main.getBoundingClientRect().right),
           menuLeft: Math.round(menu.getBoundingClientRect().left),
           clusterLeft: cluster ? Math.round(cluster.getBoundingClientRect().left) : null,
           clockDir: readout ? getComputedStyle(readout).direction : null,
           clockRtl: readout ? readout.getAttribute('dir') : null,
           emboss: getComputedStyle(doc).getPropertyValue('--neu-shadow-raised').trim(),
           viewport: doc.clientWidth,
         };
       })()`
    );
    check(`rtl: the real language toggle flips the document ("${flipped}")`,
          { dir: rtl.dir }, (v) => v.dir === "rtl");
    check("rtl: the rail moves to the trailing edge and the content takes the lead edge",
          { railLeft: rtl.railLeft, railWidth: rtl.railWidth, mainRight: rtl.mainRight, viewport: rtl.viewport },
          (v) => v.railLeft + v.railWidth >= v.viewport - 1 && v.mainRight <= v.railLeft + 1);
    check("rtl: the bar's clusters mirror (the nav toggle is to the RIGHT of the action cluster)",
          { menuLeft: rtl.menuLeft, clusterLeft: rtl.clusterLeft },
          (v) => v.clusterLeft === null || v.menuLeft > v.clusterLeft);
    check("rtl: no horizontal page overflow at 1440", rtl.overflow, (v) => v <= 1);
    check("rtl: the clock stays an LTR island (a clock is not text)",
          { dir: rtl.clockDir, attr: rtl.clockRtl }, (v) => v.dir === "ltr" && v.attr === "ltr");
    check("rtl: the emboss is NOT mirrored (a light source does not read text)",
          rtl.emboss, (v) => /^6px 6px 14px /.test(v));

    // the mobile drawer, in RTL: it must arrive from the right and leave to the right
    await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    const closedLeft = await evalJs(
      `(() => {
         const d = document.querySelector('aside[aria-hidden="true"]');
         return d ? Math.round(d.getBoundingClientRect().left) : null;
       })()`
    );
    const opened = await evalJs(
      `(() => {
         const btn = document.querySelector('header button[aria-expanded][aria-label]');
         if (!btn) return null;
         btn.click();
         return btn.getAttribute('aria-label');
       })()`
    );
    await sleep(600);
    const open = await evalJs(
      `(() => {
         const d = document.querySelector('aside[role="dialog"][aria-modal="true"]');
         if (!d) return null;
         const r = d.getBoundingClientRect();
         return { left: Math.round(r.left), right: Math.round(r.right), vw: document.documentElement.clientWidth };
       })()`
    );
    check("rtl: the CLOSED drawer is off-screen to the trailing edge, not over the content",
          { closedLeft, viewport: 375 }, (v) => v.closedLeft === null || v.closedLeft >= v.viewport - 1);
    check(`rtl: the drawer opens from the trailing edge ("${opened}")`,
          open, (v) => !!v && v.right >= v.vw - 1 && v.left > 0);
    await pressKey("Escape");
    await sleep(450);
    await send("Emulation.clearDeviceMetricsOverride");

    /* ── the PAGE, not just the chrome ──
       The shell's direction is asserted above. This measures what the logical
       migration actually rewrote inside the pages — the tables, whose header
       rows are the densest concentration of direction-bearing utilities in the
       app (137 of them).

       It is read as a BEFORE/AFTER over the SAME columns, and it measures the
       RENDERED text position (a Range over the cell's contents), not a class
       name: a `text-end` that Tailwind never emitted, or a `start-<n>` that
       resolved to the wrong property, would both leave the text where it was —
       which is exactly what a class-name check cannot see. */
    const readTable = () =>
      evalJs(
        `(() => {
           const table = document.querySelector('table');
           if (!table) return null;
           const heads = Array.from(table.querySelectorAll('thead th'))
             .filter((h) => (h.textContent || '').trim().length > 0);
           const first = table.querySelector('tbody td');
           const box = table.getBoundingClientRect();
           const hug = (el) => {
             const b = el.getBoundingClientRect();
             const range = document.createRange();
             range.selectNodeContents(el);
             const text = range.getBoundingClientRect();
             if (text.width <= 0) return null;
             return { start: Math.round(text.left - b.left), end: Math.round(b.right - text.right) };
           };
           return {
             dir: document.documentElement.dir,
             overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
             heads: heads.map(hug),
             cellFromLead: first ? Math.round(first.getBoundingClientRect().left - box.left) : null,
             cellFromTrail: first ? Math.round(box.right - first.getBoundingClientRect().right) : null,
           };
         })()`
      );
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const tableRtl = await readTable();

    // back to English, so nothing after this block inherits RTL
    await setLocale("en");
    await sleep(700);
    const restored = await evalJs("document.documentElement.dir");
    check("rtl: the language toggle restores LTR (the flip is not one-way)",
          restored, (v) => v === "ltr");

    const tableLtr = await readTable();
    const sameColumns = !!tableLtr && !!tableRtl && tableLtr.heads.length === tableRtl.heads.length;
    const edges = sameColumns
      ? tableLtr.heads.map((h, i) => {
          const r = tableRtl.heads[i];
          if (!h || !r) return "missing";
          // a centred column hugs neither edge and legitimately reads the same
          if (Math.abs(h.start - h.end) <= 4) return "centered";
          const huggedLeadInLtr = h.start < h.end;
          const huggedLeadInRtl = r.start < r.end;
          return huggedLeadInLtr === huggedLeadInRtl ? "SAME EDGE" : "mirrored";
        })
      : [];
    check(`rtl: every products header hugs the mirrored edge (${tableLtr ? tableLtr.heads.length : 0} columns)`,
          { columns: tableLtr ? tableLtr.heads.length : null, edges },
          // one verdict per column, or the comparison never happened
          (v) => !!v.columns && v.edges.length === v.columns
                 && v.edges.every((e) => e === "mirrored" || e === "centered"));
    check("rtl: the table's first column moves to the leading edge with the text",
          {
            ltrFromLead: tableLtr && tableLtr.cellFromLead,
            rtlFromLead: tableRtl && tableRtl.cellFromLead,
            ltrFromTrail: tableLtr && tableLtr.cellFromTrail,
            rtlFromTrail: tableRtl && tableRtl.cellFromTrail,
          },
          (v) =>
            !!v &&
            v.rtlFromLead !== null &&
            v.rtlFromLead > v.ltrFromLead &&
            v.rtlFromTrail < v.ltrFromTrail);
    check("rtl: a data page has no horizontal overflow at 1280",
          { rtl: tableRtl && tableRtl.overflow }, (v) => !v.rtl || v.rtl <= 1);
    await send("Emulation.clearDeviceMetricsOverride");
  }

  // ...and so are the state probes. A silently empty probe would otherwise
  // turn every "... adds no legacy colour" check into a tautology.
  check("state probes: :active sampled on real elements", stateTotals.press, (v) => v > 0);
  check("state probes: :disabled sampled on real controls", stateTotals.disabled, (v) => v > 0);
  check("state probes: group-*/peer-* sampled on real targets", stateTotals.relational, (v) => v > 0);

  console.log(out.join("\n"));
  console.log("\n" + (failures ? failures + " CHECK(S) FAILED" : "ALL " + out.length + " CHECKS PASSED"));
})()
  .catch((e) => { console.error("AUDIT ERROR:", e.message); failures = 1; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    for (let i = 0; i < 5; i++) {
      try { rmSync(PROFILE, { recursive: true, force: true }); break; } catch { await sleep(600); }
    }
    setTimeout(() => process.exit(failures ? 1 : 0), 300);
  });
