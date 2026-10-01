/* NEU DESIGN-SYSTEM AUDIT

   Guards the Electric Embossed Neumorphism system in docs/DESIGN-NEUMORPHISM.md.

   Compiles src/app/globals.css through the project's REAL PostCSS +
   Tailwind v4 pipeline, injects the result into real Chrome over CDP,
   and reads COMPUTED styles for a fixture that mirrors the actual
   component markup. That proves the recipes resolve in a real engine —
   shadow order and direction, radii, the OTP box, the AA-safe focus ring,
   the derived dark pair, the reduced-motion / prefers-contrast branches,
   the accent/INK split (with WCAG ratios computed in-engine against
   --neu-bg in BOTH modes), the composed-shadow tokens, and the phase-2
   page surfaces (inventory chips/cards, smart-image, scrollbar) plus the
   documented lightbox-chrome exception. It needs no Next server, so it
   can run even while a dev server holds `.next`.

   Usage: node audit-neu-theme.mjs   (npm run audit:neu)
   Exits non-zero if any check fails. Set CHROME_PATH to override the
   browser binary — needed on CI images where Chrome is not on the
   default path.
*/
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

/** Chrome binary: CHROME_PATH wins, else the per-platform default. */
const CHROME = process.env.CHROME_PATH || {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
}[process.platform] || "/usr/bin/google-chrome";

if (!existsSync(CHROME)) {
  console.error(
    `AUDIT ERROR: no Chrome at ${CHROME}\n` +
    "Set CHROME_PATH to the browser binary (or install Google Chrome)."
  );
  process.exit(1);
}

const PORT = 9346;
const PROFILE = tmpdir() + "/codebuff-neu-profile";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

let chrome = null, ws = null, msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout: " + method)); } }, 30000);
  });
}

async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}

const out = [];
let failures = 0;
function check(name, actual, pass) {
  const ok = typeof pass === "function" ? pass(actual) : actual === pass;
  if (!ok) failures++;
  out.push((ok ? "PASS  " : "FAIL  ") + name.padEnd(54) + " " + JSON.stringify(actual));
}
const has = (s) => (v) => typeof v === "string" && v.includes(s);

/** WCAG contrast ratio between any two CSS colour expressions, computed
    by the real engine (true relative luminance, not a lookup table). */
const contrastBetween = (fgExpr, bgExpr) => `(() => {
  const toRgb = (value) => {
    // A colour can arrive as rgb()/rgba() (0..255 components) or, once
    // color-mix() is involved, as color(srgb r g b) (0..1). Canvas
    // normalises BOTH to a hex, so the ratio is always on one scale.
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    const s = ctx.fillStyle;
    if (s.charAt(0) === '#') return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
    const parts = (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    return /^(?:color|oklab|oklch|lab|lch|hwb)\\(/i.test(s) ? parts.map((n) => n * 255) : parts;
  };
  const lum = ([r, g, b]) => {
    const ch = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const a = lum(toRgb(${fgExpr}));
  const b = lum(toRgb(${bgExpr}));
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
})()`;

const tokenOf = (name) =>
  `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`;

/** Resolve a custom property to a concrete colour via a probe element. */
const resolveToken = (name) => `(() => {
  const probe = document.createElement('div');
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim();
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
})()`;

/**
 * Prove a Tailwind utility generated AND resolves to the neu token it
 * claims. Tailwind silently emits nothing for an unknown class, so a
 * typo like `bg-neu-sunken` (when the token is spelled differently)
 * would otherwise pass every other check in this file.
 */
const utilityMatchesToken = (sel, cssProp, token) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { missing: ${JSON.stringify(sel)} };
  const want = ${resolveToken(token)};
  return { got: getComputedStyle(el).${cssProp}, want };
})()`;

/** Resolve ANY CSS colour expression — including color-mix() and var() —
    to the rgb() the engine actually paints. Used to prove a token IS the
    mix it claims to be, without depending on whether getComputedStyle
    hands back the substituted or the declared form of the expression. */
const colourExpr = (expr) => `(() => {
  const probe = document.createElement('div');
  probe.style.color = ${JSON.stringify(expr)};
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
})()`;

/** Contrast between two --neu-* custom properties. */
const contrastExpr = (fgVar, bgVar) => contrastBetween(tokenOf(fgVar), tokenOf(bgVar));

/** Contrast of a selector's own ink against its own background. */
const contrastOfEl = (sel, fgProp = "color", bgProp = "backgroundColor") =>
  contrastBetween(
    `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).${fgProp}`,
    `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).${bgProp}`
  );

/** The solid status badge: white SVG mark on the badge's own fill. */
const solidBadge = (variant) => contrastBetween(
  `getComputedStyle(document.querySelector('.neu-status-badge-${variant} svg')).color`,
  `getComputedStyle(document.querySelector('.neu-status-badge-${variant}')).backgroundColor`
);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Slice a window of compiled CSS starting at the first `pattern` match.
    Needed because a rule body can nest an @supports block, which a naive
    `\{[^}]*\}` capture would truncate before the later declarations. */
const blockAt = (source, pattern, len) => {
  const i = source.search(pattern);
  return i < 0 ? "" : source.slice(i, i + len);
};

/** Computed style props of `sel`, optionally of a pseudo element. */
const cssOf = (sel, props, pseudo = null) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const cs = getComputedStyle(el${pseudo ? `, ${JSON.stringify(pseudo)}` : ""});
  return Object.fromEntries(${JSON.stringify(props)}.map(p => [p, cs.getPropertyValue(p).trim()]));
})()`;

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>neu</title>
<style>__CSS__</style></head><body>
  <div class="neu-card" style="width:400px">
    <label class="neu-label">Email address</label>
    <input type="email" class="neu-input neu-focus" placeholder="a@b.com">
    <button type="submit" class="neu-btn neu-focus neu-btn-block">Sign in</button>
    <input class="neu-input neu-input-otp" inputmode="numeric" maxlength="1" value="7">
    <select class="neu-select"><option>One</option></select>
    <span class="neu-badge neu-badge-danger">Low</span>
    <div class="neu-empty-icon"><svg width="20" height="20"></svg></div>
    <div class="neu-skeleton" style="height:20px"></div>
    <hr class="neu-separator-h">
  </div>
  <div class="neu-elevated neu-toast">
    <span class="neu-toast-icon neu-toast-icon-success"><svg width="18" height="18"></svg></span>
    <p>Saved</p>
  </div>
  <div class="neu-card text-center is-success">
    <div class="neu-status-badge neu-status-badge-success">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4.5 12.75l6 6 9-13.5"/></svg>
    </div>
    <h2 class="neu-status-heading neu-status-heading-success mt-4">Account created</h2>
    <p class="neu-status-body mt-2">Your account is ready.</p>
  </div>
  <div class="neu-card text-center is-status-in">
    <div class="neu-status-badge neu-status-badge-warning"><svg width="28" height="28"></svg></div>
    <h2 class="neu-status-heading neu-status-heading-warning">Check the details</h2>
  </div>
  <div class="neu-card text-center is-status-in">
    <div class="neu-status-badge neu-status-badge-danger"><svg width="28" height="28"></svg></div>
    <h2 class="neu-status-heading neu-status-heading-danger">Something went wrong</h2>
  </div>
  <span class="neu-badge neu-badge-solid neu-badge-success">Paid</span>
  <div id="util-sunken" class="bg-neu-sunken"></div>
  <div id="util-scrim" class="bg-neu-scrim"></div>
  <div id="util-solid-ink" class="bg-neu-solid-ink"></div>
  <div id="util-accent-ink" class="text-neu-accent-ink"></div>
  <div id="util-accent-wash" class="bg-neu-accent-wash text-neu-accent-ink"></div>
  <div id="util-accent-line" class="border border-neu-accent-line"></div>
  <div id="util-accent-solid" class="bg-neu-accent-solid text-neu-solid-ink"></div>
  <div id="util-wash-green" class="bg-neu-wash-green text-neu-ink-green">ok</div>
  <div id="util-hairline" class="border border-neu-hairline"></div>
  <div id="util-divide" class="divide-y divide-neu-hairline"><p class="h-2"></p><p class="h-2"></p></div>
  <div class="neu-raised" style="width:40px;height:40px"></div>
  <div class="neu-inset" style="width:40px;height:40px"></div>
  <div class="neu-inset-sm" style="width:40px;height:40px"></div>
  <div class="neu-disabled" style="width:40px;height:40px"></div>
  <div class="bg-neu-bg text-neu-primary text-neu-muted text-neu-red bg-neu-cyan bg-neu-green bg-neu-amber"></div>
  <div id="ink-cyan" class="text-neu-ink-cyan"></div>
  <div id="ink-green" class="text-neu-ink-green"></div>
  <div id="ink-amber" class="text-neu-ink-amber"></div>
  <div id="ink-red" class="text-neu-ink-red"></div>
  <div class="inv-route-node">WH-A → WH-B</div>
  <div class="inventory-empty">
    <div class="inventory-empty-icon"><svg width="20" height="20"></svg></div>
    <p class="inventory-empty-title">Nothing here</p>
    <p class="inventory-empty-desc">Add stock to get started</p>
  </div>
  <div class="inventory-transfer-card" style="width:200px;height:40px"></div>
  <div class="smart-image" style="width:60px;height:60px">
    <span class="smart-image-icon"><svg width="20" height="20"></svg></span>
  </div>
  <button class="lightbox-close"><svg width="16" height="16"></svg></button>
  <div class="lightbox-counter">1 / 3</div>
  <div class="neu-image-frame lightbox-frame" style="width:60px;height:60px">
    <img class="lightbox-img" alt="" src="data:,">
  </div>
  <div class="neu-raised-sm" style="width:40px;height:40px"></div>
</body></html>`;

(async () => {
  const css = (await postcss([tailwind()]).process(
    readFileSync("src/app/globals.css", "utf8"),
    { from: "src/app/globals.css" }
  )).css;

  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    // CI images (and root containers generally) have no usable user
    // namespaces, so Chrome refuses to start its sandbox there.
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
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
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await send("Page.enable"); await send("Runtime.enable");
  // Without this, el.focus() never matches :focus in headless Chrome and
  // every focus-ring assertion silently reads the unfocused style.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const tree = await send("Page.getFrameTree");
  const frameId = tree.frameTree.frame.id;
  await send("Page.setDocumentContent", { frameId, html: FIXTURE.replace("__CSS__", css) });
  await sleep(400);

  // ══════════════ tokens / surface ══════════════
  const body = await evalJs(cssOf("body", ["background-color", "color"]));
  check("body surface is --neu-bg", body["background-color"], "rgb(230, 236, 240)");
  check("body ink is --neu-text-primary", body.color, "rgb(51, 65, 85)");

  const tokens = await evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return { bg: g('--neu-bg'), dark: g('--neu-shadow-dark'), light: g('--neu-shadow-light'),
             radiusLg: g('--neu-radius-lg'), radiusMd: g('--neu-radius-md'), radiusSm: g('--neu-radius-sm'),
             transition: g('--neu-transition') };
  })()`);
  check("tokens: --neu-bg", tokens.bg, "#e6ecf0");
  check("tokens: --neu-shadow-dark", tokens.dark, "#babecc");
  check("tokens: --neu-shadow-light", tokens.light, "#ffffff");
  check("tokens: radii 28/16/12", tokens.radiusLg + "/" + tokens.radiusMd + "/" + tokens.radiusSm, "28px/16px/12px");
  check("tokens: --neu-transition", tokens.transition, "150ms ease");

  // ══════════════ the accent / INK split ══════════════
  // The spec's "electric" hues are decoration only; anything whose
  // colour carries meaning uses a same-hue ink that clears AA.
  const ink = await evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return { cyan: g('--neu-ink-cyan'), green: g('--neu-ink-green'), amber: g('--neu-ink-amber'),
             red: g('--neu-ink-red'), violet: g('--neu-ink-violet'),
             ring: g('--neu-focus-ring'), ringRgb: g('--neu-focus-rgb'),
             faint: g('--neu-text-faint'),
             accentCyan: g('--neu-accent-cyan'), accentGreen: g('--neu-accent-green'),
             accentAmber: g('--neu-accent-amber'), accentRed: g('--neu-accent-red'),
             radiusFull: g('--neu-radius-full'),
             accInk: g('--neu-accent-ink'), accInkStrong: g('--neu-accent-ink-strong'),
             accLine: g('--neu-accent-line'), accWash: g('--neu-accent-wash'), accTint: g('--neu-accent-tint'),
             accSolid: g('--neu-accent-solid'), accSolidStrong: g('--neu-accent-solid-strong') };
  })()`);
  check("ink: --neu-ink-* are the AA set", [ink.cyan, ink.green, ink.amber, ink.red, ink.violet].join("/"), "#155e75/#166534/#92400e/#b91c1c/#6d28d9");
  check("ink: accents stay the vivid decoration", [ink.accentCyan, ink.accentGreen, ink.accentAmber, ink.accentRed].join("/"), "#00f2fe/#22c55e/#f59e0b/#ef4444");
  check("ink: each ink differs from its accent", [ink.cyan !== ink.accentCyan, ink.green !== ink.accentGreen, ink.amber !== ink.accentAmber, ink.red !== ink.accentRed].join("/"), "true/true/true/true");
  check("focus ring: --neu-focus-ring is the AA cyan", ink.ring, "#0891b2");
  check("focus ring: --neu-focus-rgb mirrors the ring", ink.ringRgb, "8 145 178");
  check("tokens: --neu-radius-full", ink.radiusFull, "9999px");

  // ══════════════ the interactive accent (the blue brand palette's heir) ══════════════
  // The legacy `--color-brand-*` accents migrated onto these. `line` is the
  // SAME variable as the focus ring on purpose: every edge the accent paints
  // has to clear SC 1.4.11, and reusing the proven cyan is how that is
  // guaranteed rather than re-measured per use.
  check("accent: ink / ink-strong are the AA cyans", [ink.accInk, ink.accInkStrong].join("/"), "#155e75/#164e63");
  check("accent: --neu-accent-line IS the focus ring (one source of truth)", ink.accLine, "#0891b2");
  check("accent: the solid fills are the mode-stable cyans", [ink.accSolid, ink.accSolidStrong].join("/"), "#0e7490/#155e75");
  check("accent: --neu-accent-wash is a color-mix of the ring and the surface",
        ink.accWash, has("--neu-focus-ring") && has("--neu-bg") && has("color-mix"));
  // Paper and spreadsheets are not --neu-bg, so the wash cannot be reused
  // there — this flat hex is what print-brand.ts mirrors.
  check("accent: --neu-accent-tint is the flat paper tint", ink.accTint, "#cbe1e9");
  for (const [name, token] of [["accent ink", "--neu-accent-ink"], ["accent ink-strong", "--neu-accent-ink-strong"]]) {
    check(`AA ${name} on --neu-bg >= 4.5:1`, await evalJs(contrastExpr(token, "--neu-bg")), (v) => v >= 4.5);
  }
  // Accent ink sits ON the wash wherever a tinted panel labels itself, so
  // that pair needs its own measurement — a wash is not the page surface.
  check("AA accent ink on --neu-accent-wash >= 4.5:1",
        await evalJs(contrastExpr("--neu-accent-ink", "--neu-accent-wash")), (v) => v >= 4.5);
  check("AA accent line on --neu-bg >= 3:1 (SC 1.4.11)",
        await evalJs(contrastExpr("--neu-accent-line", "--neu-bg")), (v) => v >= 3);
  check("AA white ink on --neu-accent-solid >= 4.5:1",
        await evalJs(contrastExpr("--neu-solid-ink", "--neu-accent-solid")), (v) => v >= 4.5);

  // ══════════════ the status washes (the legacy status palette's heir) ══════════════
  // A status chip is `bg-neu-wash-<hue> text-neu-ink-<hue>` in BOTH modes.
  // The wash is a color-mix of the hue's VIVID accent into `--neu-bg`, so it
  // re-derives with the surface and needs no `.dark` twin — which is exactly
  // why ink-on-wash is a DIFFERENT pair from ink-on-bg and has to be measured
  // on its own. This is what replaced the legacy
  // `bg-success-50 dark:bg-success-500/15` + `dark:text-success-500` chip,
  // whose dark pair scored 4.26:1 — under AA.
  const washLight = {};
  for (const hue of ["cyan", "green", "amber", "red"]) {
    const declared = await evalJs(colourExpr(`color-mix(in srgb, var(--neu-accent-${hue}) 8%, var(--neu-bg))`));
    washLight[hue] = await evalJs(resolveToken(`--neu-wash-${hue}`));
    check(`wash: --neu-wash-${hue} is 8% of --neu-accent-${hue} in --neu-bg`,
          await evalJs(`(${resolveToken(`--neu-wash-${hue}`)}) === (${colourExpr(`color-mix(in srgb, var(--neu-accent-${hue}) 8%, var(--neu-bg))`)})`),
          true);
    check(`wash: --neu-wash-${hue} is tinted, not the bare surface`,
          declared === (await evalJs(resolveToken("--neu-bg"))), false);
  }
  for (const hue of ["cyan", "green", "amber", "red"]) {
    check(`AA ${hue} ink on --neu-wash-${hue} >= 4.5:1`,
          await evalJs(contrastExpr(`--neu-ink-${hue}`, `--neu-wash-${hue}`)), (v) => v >= 4.5);
  }
  // Control: a wash is not a place for the vivid accent. The accent is the
  // wash's own tint ingredient, so promoting it back to ink collapses the
  // pair — the failure mode the ink/wash split exists to prevent.
  check("AA control: --neu-accent-amber as ink on its own wash fails 4.5:1",
        await evalJs(contrastExpr("--neu-accent-amber", "--neu-wash-amber")), (v) => v < 4.5);
  check("AA control: --neu-accent-green as ink on its own wash fails 4.5:1",
        await evalJs(contrastExpr("--neu-accent-green", "--neu-wash-green")), (v) => v < 4.5);

  // ══════════════ WCAG, measured in-engine (light) ══════════════
  for (const [name, token] of [["cyan", "--neu-ink-cyan"], ["green", "--neu-ink-green"], ["amber", "--neu-ink-amber"], ["red", "--neu-ink-red"], ["violet", "--neu-ink-violet"]]) {
    const ratio = await evalJs(contrastExpr(token, "--neu-bg"));
    check(`AA ${name} ink on --neu-bg >= 4.5:1`, ratio, (v) => v >= 4.5);
  }
  check("ink: --neu-text-faint is the third step", ink.faint, "#5a6779");
  check("AA primary ink on --neu-bg >= 4.5:1", await evalJs(contrastExpr("--neu-text-primary", "--neu-bg")), (v) => v >= 4.5);
  check("AA muted ink on --neu-bg >= 4.5:1", await evalJs(contrastExpr("--neu-text-muted", "--neu-bg")), (v) => v >= 4.5);
  check("AA faint ink on --neu-bg >= 4.5:1", await evalJs(contrastExpr("--neu-text-faint", "--neu-bg")), (v) => v >= 4.5);
  // The three-step ladder is the whole point of the token: each step must
  // be measurably dimmer than the one above it, and none may fall under
  // AA. All three are measured against the SAME surface, so the only
  // variable is the ink itself.
  const ladder = [];
  for (const t of ["--neu-text-primary", "--neu-text-muted", "--neu-text-faint"]) {
    ladder.push(await evalJs(contrastExpr(t, "--neu-bg")));
  }
  check("ladder: primary > muted > faint (no inverted steps)",
        ladder[0] > ladder[1] && ladder[1] > ladder[2], true);
  check("ladder: every step clears AA (>= 4.5:1)", ladder.every((v) => v >= 4.5), true);
  check("AA focus ring on --neu-bg >= 3:1 (SC 1.4.11)", await evalJs(contrastExpr("--neu-focus-ring", "--neu-bg")), (v) => v >= 3);
  // The accent this replaced would NOT have passed — keep that visible,
  // it is the reason the split exists at all.
  check("AA control: --neu-accent-cyan fails 3:1 (why the split exists)", await evalJs(contrastExpr("--neu-accent-cyan", "--neu-bg")), (v) => v < 3);

  // ══════════════ composed shadows are the single source ══════════════
  const composed = await evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return { raised: g('--neu-shadow-raised'), inset: g('--neu-shadow-inset'), insetSm: g('--neu-shadow-inset-sm'),
             elevated: g('--neu-shadow-elevated'), raisedSm: g('--neu-shadow-raised-sm'),
             card: g('--neu-shadow-card'), focus: g('--neu-shadow-focus'), error: g('--neu-shadow-error'),
             edge: g('--neu-shadow-edge') };
  })()`);
  const usesPair = (v) => v.includes("#babecc") && v.includes("#ffffff");
  check("composed: --neu-shadow-raised reuses the pair", composed.raised, (v) => usesPair(v) && v.includes("6px 6px 14px") && v.includes("-6px -6px 14px"));
  check("composed: --neu-shadow-inset reuses the pair", composed.inset, (v) => usesPair(v) && v.includes("inset 4px 4px 8px"));
  check("composed: --neu-shadow-inset-sm reuses the pair", composed.insetSm, (v) => usesPair(v) && v.includes("inset 2px 2px 4px"));
  check("composed: --neu-shadow-elevated reuses the pair", composed.elevated, (v) => usesPair(v) && v.includes("10px 10px 20px"));
  check("composed: --neu-shadow-raised-sm reuses the pair", composed.raisedSm, (v) => usesPair(v) && v.includes("3px 3px 7px"));
  check("composed: --neu-shadow-card keeps the cyan glow", composed.card, (v) => usesPair(v) && v.includes("0 242 254 / 0.15"));
  check("composed: --neu-shadow-focus rings in --neu-focus-rgb", composed.focus, (v) => v.includes("8 145 178 / 0.5") && v.includes("inset 2px 2px 4px"));
  check("composed: --neu-shadow-error rings in --neu-red-rgb", composed.error, (v) => v.includes("239 68 68 / 0.4") && v.includes("inset 2px 2px 4px"));
  check("composed: --neu-shadow-edge is the sticky-header hairline", composed.edge, (v) => v.includes("inset 0 -1px 0") && v.includes("#babecc"));

  // The emboss pair is referenced through the composed tokens ONLY.
  // Asserted over the compiled CSS (Node side) so it also covers the
  // legacy blocks, and so it catches a re-typed offset anywhere.
  const shadowDecls = [...css.matchAll(/box-shadow:\s*([^;}]+)/g)].map((m) => m[1].trim());
  check("single source: the emboss pair is never re-typed inline",
        shadowDecls.filter((v) => /--neu-shadow-(dark|light)/.test(v) && !/^var\(--neu-shadow-[a-z-]+\)$/.test(v)),
        (v) => v.length === 0);
  check("single source: no box-shadow hard-codes a colour",
        shadowDecls.filter((v) => /#[0-9a-f]{3,8}|rgba?\(\s*\d/.test(v)),
        (v) => v.length === 0);

  // ══════════════ page-markup utilities resolve to their tokens ══════════════
  // These are the classes the migrated page JSX now depends on. Each one
  // must (a) exist and (b) equal the token — see utilityMatchesToken.
  const sameColour = (v) => v.got && v.want && v.got === v.want;
  const utilColour = (sel, prop, token) => evalJs(utilityMatchesToken(sel, prop, token));
  check("util: .bg-neu-sunken = --neu-sunken", await utilColour("#util-sunken", "backgroundColor", "--neu-sunken"), sameColour);
  check("util: .border-neu-hairline = --neu-hairline", await utilColour("#util-hairline", "borderTopColor", "--neu-hairline"), sameColour);
  // Tailwind v4's `divide-*` targets `> :not(:last-child)`, so the FIRST
  // child is the one that carries the divider colour.
  check("util: .divide-neu-hairline = --neu-hairline", await utilColour("#util-divide > p:first-child", "borderTopColor", "--neu-hairline"), sameColour);
  check("util: .bg-neu-scrim is the mode-stable scrim", (await utilColour("#util-scrim", "backgroundColor", "--neu-scrim-rgb")).got, "rgb(51, 65, 85)");
  check("util: .bg-neu-solid-ink is white", (await utilColour("#util-solid-ink", "backgroundColor", "--neu-solid-ink")).got, "rgb(255, 255, 255)");
  // The accent utilities the brand migration introduced — each has to
  // compile AND resolve, or the whole accent palette would be silently dead.
  check("util: .text-neu-accent-ink = --neu-accent-ink", await utilColour("#util-accent-ink", "color", "--neu-accent-ink"), sameColour);
  check("util: .bg-neu-accent-wash = --neu-accent-wash", await utilColour("#util-accent-wash", "backgroundColor", "--neu-accent-wash"), sameColour);
  check("util: .border-neu-accent-line = --neu-accent-line", await utilColour("#util-accent-line", "borderTopColor", "--neu-accent-line"), sameColour);
  check("util: .bg-neu-accent-solid = --neu-accent-solid", await utilColour("#util-accent-solid", "backgroundColor", "--neu-accent-solid"), sameColour);
  // The status-chip pair the semantic migration introduced: the wash has to
  // compile AND resolve to the mode-aware mix, and the ink on it to the ink.
  check("util: .bg-neu-wash-green = --neu-wash-green", await utilColour("#util-wash-green", "backgroundColor", "--neu-wash-green"), sameColour);
  check("util: .text-neu-ink-green = --neu-ink-green", await utilColour("#util-wash-green", "color", "--neu-ink-green"), sameColour);
  check("util: the wash chip's own ink clears AA on its own wash",
        await evalJs(contrastOfEl("#util-wash-green")), (v) => v >= 4.5);

  // ══════════════ theme utilities resolve (badge + stat-card use these) ══════════════
  for (const [name, cls, expected] of [["cyan", "text-neu-ink-cyan", "rgb(21, 94, 117)"], ["green", "text-neu-ink-green", "rgb(22, 101, 52)"], ["amber", "text-neu-ink-amber", "rgb(146, 64, 14)"], ["red", "text-neu-ink-red", "rgb(185, 28, 28)"]]) {
    const got = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify("#ink-" + name)}); return el ? getComputedStyle(el).color : null; })()`);
    check(`theme: .${cls} resolves`, got, expected);
  }

  // ══════════════ recipes are combinable ══════════════
  const raised = await evalJs(cssOf("div.neu-raised", ["box-shadow", "background-color"]));
  const inset = await evalJs(cssOf("div.neu-inset", ["box-shadow"]));
  const insetSm = await evalJs(cssOf("div.neu-inset-sm", ["box-shadow"]));
  const disabled = await evalJs(cssOf("div.neu-disabled", ["box-shadow", "cursor", "opacity", "color"]));
  check("recipe: .neu-raised offsets", raised["box-shadow"], has("6px 6px 14px"));
  check("recipe: .neu-raised is NOT inset", raised["box-shadow"], (v) => !v.includes("inset"));
  check("recipe: .neu-raised light side", raised["box-shadow"], has("-6px -6px 14px"));
  check("recipe: .neu-raised surface is --neu-bg", raised["background-color"], "rgb(230, 236, 240)");
  const raisedSm = await evalJs(cssOf("div.neu-raised-sm", ["box-shadow", "background-color"]));
  check("recipe: .neu-raised-sm offsets (the small raised step)",
        raisedSm?.["box-shadow"],
        (v) => typeof v === "string" && v.includes("3px 3px 7px") && v.includes("-3px -3px 7px") && !v.includes("inset"));
  check("recipe: .neu-raised-sm surface is --neu-bg", raisedSm?.["background-color"], "rgb(230, 236, 240)");
  check("recipe: .neu-inset offsets", inset["box-shadow"], (v) => v.includes("4px 4px 8px") && v.includes("inset"));
  check("recipe: .neu-inset-sm offsets", insetSm["box-shadow"], (v) => v.includes("2px 2px 4px") && v.includes("inset"));
  check("recipe: .neu-disabled offsets", disabled["box-shadow"], has("3px 3px 7px"));
  check("recipe: .neu-disabled is muted + not-allowed", disabled.color + " " + disabled.cursor + " " + disabled.opacity, "rgb(71, 85, 105) not-allowed 0.7");

  // ══════════════ card ══════════════
  const card = await evalJs(cssOf("div.neu-card", ["border-radius", "box-shadow", "padding", "background-color"]));
  check("card radius = --neu-radius-lg", card["border-radius"], "28px");
  check("card padding is 36/28", card.padding, "36px 28px");
  check("card surface is --neu-bg", card["background-color"], "rgb(230, 236, 240)");
  check("card has the dark emboss", card["box-shadow"], has("rgb(186, 190, 204)"));
  check("card has the light emboss", card["box-shadow"], has("rgb(255, 255, 255)"));
  check("card emboss is dual-direction", card["box-shadow"], has("14px 14px 28px"));
  check("card emboss opposes (light side)", card["box-shadow"], has("-14px -14px 28px"));
  check("card has the cyan glow", card["box-shadow"], has("rgba(0, 242, 254, 0.15)"));

  const before = await evalJs(cssOf("div.neu-card", ["background-image", "pointer-events", "mask-composite"], "::before"));
  check("card ::before paints the cyan gradient border", before["background-image"], has("linear-gradient"));
  check("card ::before is click-through", before["pointer-events"], "none");

  // ══════════════ label ══════════════
  const label = await evalJs(cssOf("label.neu-label", ["font-size", "font-weight", "color", "letter-spacing", "box-shadow"]));
  check("label is 13px/600", label["font-size"] + "/" + label["font-weight"], "13px/600");
  check("label ink is the AA-tuned muted (#475569)", label.color, "rgb(71, 85, 105)");
  check("label letter-spacing 0.01em", label["letter-spacing"], "0.13px");
  check("label carries no shadow/box", label["box-shadow"], "none");

  // ══════════════ input ══════════════
  const input = await evalJs(cssOf("input[type=email]", ["height", "border-radius", "box-shadow", "border-top-color", "font-size", "font-weight", "appearance", "text-align", "padding-left"]));
  check("input height is 48px", input.height, "48px");
  check("input radius = --neu-radius-md", input["border-radius"], "16px");
  check("input wears the inset emboss", input["box-shadow"], has("4px 4px 8px"));
  check("input emboss is inset (recessed)", input["box-shadow"], has("inset"));
  check("input border is stripped (transparent)", input["border-top-color"], "rgba(0, 0, 0, 0)");
  check("input type is 16px/500", input["font-size"] + "/" + input["font-weight"], "16px/500");
  check("input appearance stripped", input.appearance, "none");
  check("input is start-aligned with 16px padding", input["text-align"] + "/" + input["padding-left"], "start/16px");

  // A task boundary: :focus does not match until Chrome has processed the
  // focus in the same tick we call .focus().
  const focus = await evalJs(`(async () => {
    const el = document.querySelector('input[type=email]');
    el.focus();
    // 250ms > the 150ms --neu-transition, so we read the settled colour.
    await new Promise(r => setTimeout(r, 250));
    const cs = getComputedStyle(el);
    return { isFocus: el.matches(':focus'), border: cs.borderTopColor, shadow: cs.boxShadow };
  })()`);
  check("focus: input actually matches :focus", focus.isFocus, true);
  check("focus: border turns the AA-safe cyan", focus.border, "rgb(8, 145, 178)");
  check("focus: cyan glow added", focus.shadow, has("rgba(8, 145, 178, 0.5)"));
  check("focus: inset emboss kept", focus.shadow, (v) => v.includes("2px 2px 4px") && v.includes("inset"));

  const otp = await evalJs(cssOf("input.neu-input-otp", ["width", "height", "font-size", "font-weight", "text-align"]));
  check("OTP box is 56x64", otp.width + "x" + otp.height, "56pxx64px");
  check("OTP text is 24px/700 centred", otp["font-size"] + "/" + otp["font-weight"] + " " + otp["text-align"], "24px/700 center");

  const sel = await evalJs(cssOf("select.neu-select", ["height", "appearance", "box-shadow", "background-image"]));
  check("select height is 48px", sel.height, "48px");
  check("select appearance stripped", sel.appearance, "none");
  check("select wears the inset emboss", sel["box-shadow"], has("inset"));

  // ══════════════ button ══════════════
  const btn = await evalJs(cssOf("button.neu-btn", ["height", "border-radius", "box-shadow", "border-top-width", "font-weight", "font-size", "width", "color"]));
  check("button height is the 52px spec", btn.height, "52px");
  check("button radius = --neu-radius-md", btn["border-radius"], "16px");
  check("button wears the raised emboss", btn["box-shadow"], has("6px 6px 14px"));
  check("button has no border", btn["border-top-width"], "0px");
  check("button is 16px/600", btn["font-size"] + "/" + btn["font-weight"], "16px/600");
  check("button ink is --neu-text-primary", btn.color, "rgb(51, 65, 85)");
  check("CTA is full width", btn.width, (v) => parseFloat(v) > 300);

  // ══════════════ badge ══════════════
  const badge = await evalJs(cssOf("span.neu-badge", ["height", "border-radius", "font-size", "font-weight", "box-shadow", "color"]));
  check("badge height is 24px", badge.height, "24px");
  check("badge radius is 12px", badge["border-radius"], "12px");
  check("badge is 12px/600", badge["font-size"] + "/" + badge["font-weight"], "12px/600");
  check("badge uses the SMALL inset", badge["box-shadow"], has("2px 2px 4px"));
  check("badge danger variant is red ink", badge.color, "rgb(185, 28, 28)");

  // ══════════════ separator ══════════════
  const sep = await evalJs(cssOf("hr.neu-separator-h", ["height", "border-top-color", "border-bottom-color", "background-color"]));
  // The spec's separator is TWO 1px lines (dark over light), so the
  // element resolves to 2px total — that is the intended render.
  const sepW = await evalJs(cssOf("hr.neu-separator-h", ["border-top-width", "border-bottom-width"]));
  check("separator is a 1px/1px two-line emboss", sepW["border-top-width"] + "/" + sepW["border-bottom-width"], "1px/1px");
  check("separator emboss: dark top edge", sep["border-top-color"], "rgb(186, 190, 204)");
  check("separator emboss: light bottom edge", sep["border-bottom-color"], "rgb(255, 255, 255)");

  // ══════════════ skeleton ══════════════
  const sk = await evalJs(`(() => {
    const el = document.querySelector('.neu-skeleton');
    const cs = getComputedStyle(el);
    const a = getComputedStyle(el, '::after');
    return { shadow: cs.boxShadow, radius: cs.borderRadius, overflow: cs.overflow, anim: a.animationName, dur: a.animationDuration, bg: a.backgroundImage };
  })()`);
  check("skeleton wears the inset emboss", sk.shadow, has("inset"));
  check("skeleton radius = --neu-radius-sm", sk.radius, "12px");
  check("skeleton clips the sweep", sk.overflow, "hidden");
  check("skeleton sweep is the 1.6s shimmer", sk.anim + " " + sk.dur, "neuShimmer 1.6s");
  check("skeleton sweep is a white gradient", sk.bg, has("rgba(255, 255, 255, 0.4)"));

  // ══════════════ toast ══════════════
  const toast = await evalJs(cssOf(".neu-toast", ["border-radius", "padding", "display", "gap", "box-shadow", "animation-name", "flex-direction"]));
  check("toast uses .neu-elevated (10px pair)", toast["box-shadow"], has("10px 10px 20px"));
  check("toast radius = --neu-radius-md", toast["border-radius"], "16px");
  check("toast padding is 14/18", toast.padding, "14px 18px");
  check("toast is a flex row with 10px gap", toast.display + "/" + toast["flex-direction"] + "/" + toast.gap, "flex/row/10px");
  check("toast slides in via neuToastIn", toast["animation-name"], "neuToastIn");

  const toastIcon = await evalJs(cssOf(".neu-toast-icon-success", ["color"]));
  check("toast success icon uses the green INK", toastIcon.color, "rgb(22, 101, 52)");

  // ══════════════ success / status swap ══════════════
  const swap = await evalJs(`(() => {
    const panel = document.querySelector('.is-success');
    const badge = document.querySelector('.neu-status-badge-success');
    const bcs = getComputedStyle(badge);
    return {
      anim: getComputedStyle(panel).animationName,
      bg: bcs.backgroundColor,
      shadow: bcs.boxShadow,
      w: bcs.width, h: bcs.height, radius: bcs.borderRadius,
      iconColor: getComputedStyle(badge.querySelector('svg')).color,
      iconW: getComputedStyle(badge.querySelector('svg')).width,
      heading: getComputedStyle(document.querySelector('.neu-status-heading')).fontSize,
      headingColor: getComputedStyle(document.querySelector('.neu-status-heading')).color,
      bodySize: getComputedStyle(document.querySelector('.neu-status-body')).fontSize,
      bodyColor: getComputedStyle(document.querySelector('.neu-status-body')).color,
      text: panel.textContent,
    };
  })()`);
  check("swap animates via neuStateIn (opacity/transform)", swap.anim, "neuStateIn");
  check("status badge is a solid green fill", swap.bg, "rgb(21, 128, 61)");
  check("status badge is NOT embossed", swap.shadow, (v) => !/186, 190, 204|babecc/.test(v));
  check("status badge glow is 0 8px 20px rgba(green,.35)", swap.shadow, has("rgba(34, 197, 94, 0.35)"));
  check("status badge is a 64px circle", swap.w + "x" + swap.h + "/" + swap.radius, "64pxx64px/50%");
  check("status icon is a white SVG at 28px", swap.iconColor + " " + swap.iconW, "rgb(255, 255, 255) 28px");
  check("status heading is 22px green INK", swap.heading + " " + swap.headingColor, "22px rgb(22, 101, 52)");
  check("status body is 14px muted", swap.bodySize + " " + swap.bodyColor, "14px rgb(71, 85, 105)");
  check("status panel uses text, never emoji/icon-font", swap.text, (v) => !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(v) && /Account created/.test(v));

  // ══════════════ solid-fill glyph contrast ══════════════
  // White on the SPEC's vivid accents measured 2.15–2.28:1, under the 3:1
  // non-text minimum for the badge's mark. The mode-stable --neu-solid-*
  // fills keep the accent circle while clearing it.
  const solid = await evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return { ink: g('--neu-solid-ink'), cyan: g('--neu-solid-cyan'), green: g('--neu-solid-green'),
             amber: g('--neu-solid-amber'), red: g('--neu-solid-red'),
             accentGreen: g('--neu-accent-green'), accentAmber: g('--neu-accent-amber') };
  })()`);
  check("solid: --neu-solid-ink is white", solid.ink, "#ffffff");
  check("solid: fills are the deep mode-stable set", [solid.cyan, solid.green, solid.amber, solid.red].join("/"), "#0e7490/#15803d/#b45309/#b91c1c");
  for (const variant of ["success", "warning", "danger"]) {
    check(`AA: solid badge ${variant} white glyph >= 3:1`, await evalJs(solidBadge(variant)), (v) => v >= 3);
  }
  check("AA: .neu-badge-solid white ink >= 4.5:1", await evalJs(contrastOfEl("span.neu-badge-solid")), (v) => v >= 4.5);
  // The vivid accents this replaced would NOT have passed — keep that visible.
  check("AA control: white on --neu-accent-green fails 3:1",
        await evalJs(contrastBetween("'#ffffff'", tokenOf("--neu-accent-green"))), (v) => v < 3);
  check("AA control: white on --neu-accent-amber fails 3:1",
        await evalJs(contrastBetween("'#ffffff'", tokenOf("--neu-accent-amber"))), (v) => v < 3);

  // ══════════════ focus ring on every interactive element ══════════════
  const rings = await evalJs(`(async () => {
    const report = {};
    for (const sel of ['button.neu-btn', 'a.neu-btn-plain', 'input.neu-input', 'select.neu-select']) {
      const el = document.querySelector(sel);
      if (!el) { report[sel] = null; continue; }
      el.focus();
      await new Promise(r => setTimeout(r, 250));
      const cs = getComputedStyle(el);
      report[sel] = {
        outline: cs.outlineColor + ' ' + cs.outlineWidth + ' ' + cs.outlineStyle,
        border: cs.borderTopColor,
        glow: cs.boxShadow,
        focused: el.matches(':focus'),
      };
    }
    return report;
  })()`);
  check("focus: button gets the AA cyan outline ring", rings["button.neu-btn"].outline, "rgb(8, 145, 178) 2px solid");
  check("focus: input turns cyan (Input spec pattern)", rings["input.neu-input"].border, "rgb(8, 145, 178)");
  check("focus: input gets the cyan glow", rings["input.neu-input"].glow, has("rgba(8, 145, 178, 0.5)"));
  check("focus: select turns cyan (Input spec pattern)", rings["select.neu-select"].border, "rgb(8, 145, 178)");
  check("focus: select gets the cyan glow", rings["select.neu-select"].glow, has("rgba(8, 145, 178, 0.5)"));
  check("focus: input+select both matched :focus", rings["input.neu-input"].focused + "/" + rings["select.neu-select"].focused, "true/true");

  // ══════════════ dark mode (derived pair) ══════════════
  const dark = await evalJs(`(() => {
    // Swapping the theme animates background-color AND box-shadow on the
    // body and on every recipe, so kill transitions before toggling —
    // otherwise we read the mid-transition (light) values.
    const kill = document.createElement('style');
    kill.id = 'audit-no-transition';
    kill.textContent = '* { transition: none !important; }';
    document.head.appendChild(kill);
    document.documentElement.classList.add('dark');
    const root = getComputedStyle(document.documentElement);
    const g = n => root.getPropertyValue(n).trim();
    const card = getComputedStyle(document.querySelector('div.neu-card'));
    const raised = getComputedStyle(document.querySelector('div.neu-raised'));
    const surfaces = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
    return { bg: g('--neu-bg'), text: g('--neu-text-primary'), muted: g('--neu-text-muted'),
             faint: g('--neu-text-faint'),
             dark: g('--neu-shadow-dark'), light: g('--neu-shadow-light'),
             raisedVar: g('--neu-shadow-raised'), insetVar: g('--neu-shadow-inset'),
             raisedSmVar: g('--neu-shadow-raised-sm'), elevatedVar: g('--neu-shadow-elevated'),
             inkCyan: g('--neu-ink-cyan'), inkGreen: g('--neu-ink-green'),
             inkAmber: g('--neu-ink-amber'), inkRed: g('--neu-ink-red'),
             solidGreen: g('--neu-solid-green'), solidAmber: g('--neu-solid-amber'), solidRed: g('--neu-solid-red'),
             ring: g('--neu-focus-ring'), ringRgb: g('--neu-focus-rgb'),
             body: getComputedStyle(document.body).backgroundColor, shadow: card.boxShadow,
             raised: raised.boxShadow,
             transferBg: surfaces('div.inventory-transfer-card'), routeNodeBg: surfaces('div.inv-route-node'),
             emptyIconBg: surfaces('div.inventory-empty-icon'), smartBg: surfaces('div.smart-image') };
  })()`);
  check("dark: surface derived", dark.bg, "#1e293b");
  check("dark: primary ink derived", dark.text, "#f1f5f9");
  check("dark: muted ink derived", dark.muted, "#94a3b8");
  check("dark: faint ink derived", dark.faint, "#8a97a8");
  check("dark: BOTH shadows re-derived", dark.dark + "/" + dark.light, "#141c28/#283449");
  check("dark: body surface follows the token", dark.body, "rgb(30, 41, 59)");
  check("dark: card emboss uses the dark pair", dark.shadow, (v) => v.includes("rgb(20, 28, 40)") && v.includes("rgb(40, 52, 73)"));

  // The composed tokens are declared on :root, so they must re-derive
  // when `.dark` lands on <html>. This is the invariant that lets every
  // recipe reference var(--neu-shadow-*) instead of the raw pair.
  const darkPair = (v) => v.includes("#141c28") && v.includes("#283449");
  check("dark: --neu-shadow-raised re-derives (invariant)", dark.raisedVar, darkPair);
  check("dark: --neu-shadow-inset re-derives", dark.insetVar, darkPair);
  check("dark: --neu-shadow-raised-sm re-derives", dark.raisedSmVar, darkPair);
  check("dark: --neu-shadow-elevated re-derives", dark.elevatedVar, darkPair);
  check("dark: .neu-raised renders the derived pair", dark.raised, (v) => v.includes("rgb(20, 28, 40)") && v.includes("rgb(40, 52, 73)"));

  check("dark: ink flips to the lighter AA set", [dark.inkCyan, dark.inkGreen, dark.inkAmber, dark.inkRed].join("/"), "#22d3ee/#4ade80/#fbbf24/#f87171");
  check("dark: focus ring brightens + triplet follows", dark.ring + " " + dark.ringRgb, "#22d3ee 34 211 238");

  // ══════════════ WCAG, measured in-engine (dark) ══════════════
  for (const [name, token] of [["cyan", "--neu-ink-cyan"], ["green", "--neu-ink-green"], ["amber", "--neu-ink-amber"], ["red", "--neu-ink-red"]]) {
    const ratio = await evalJs(contrastExpr(token, "--neu-bg"));
    check(`dark AA ${name} ink on --neu-bg >= 4.5:1`, ratio, (v) => v >= 4.5);
  }
  check("dark AA primary ink on --neu-bg >= 4.5:1", await evalJs(contrastExpr("--neu-text-primary", "--neu-bg")), (v) => v >= 4.5);
  check("dark AA muted ink on --neu-bg >= 4.5:1", await evalJs(contrastExpr("--neu-text-muted", "--neu-bg")), (v) => v >= 4.5);
  check("dark AA faint ink on --neu-bg >= 4.5:1", await evalJs(contrastExpr("--neu-text-faint", "--neu-bg")), (v) => v >= 4.5);
  {
    const darkLadder = [];
    for (const t of ["--neu-text-primary", "--neu-text-muted", "--neu-text-faint"]) {
      darkLadder.push(await evalJs(contrastExpr(t, "--neu-bg")));
    }
    check("dark ladder: primary > muted > faint, all AA",
          darkLadder[0] > darkLadder[1] && darkLadder[1] > darkLadder[2] && darkLadder.every((v) => v >= 4.5),
          true);
  }
  check("dark AA focus ring on --neu-bg >= 3:1", await evalJs(contrastExpr("--neu-focus-ring", "--neu-bg")), (v) => v >= 3);

  // The migrated page surfaces must follow --neu-bg with NO dark override.
  check("dark: page surfaces follow --neu-bg (no override needed)",
        [dark.transferBg, dark.routeNodeBg, dark.emptyIconBg, dark.smartBg].join("/"),
        "rgb(30, 41, 59)/rgb(30, 41, 59)/rgb(30, 41, 59)/rgb(30, 41, 59)");
  // The solid fills must NOT flip: a white glyph needs a dark fill in
  // both modes, which is exactly why they are separate from --neu-ink-*.
  check("dark: solid fills stay put (they hold white ink)",
        [dark.solidGreen, dark.solidAmber, dark.solidRed].join("/"), "#15803d/#b45309/#b91c1c");
  for (const variant of ["success", "warning", "danger"]) {
    check(`dark AA: solid badge ${variant} white glyph >= 3:1`, await evalJs(solidBadge(variant)), (v) => v >= 3);
  }
  check("dark AA: .neu-badge-solid white ink >= 4.5:1", await evalJs(contrastOfEl("span.neu-badge-solid")), (v) => v >= 4.5);
  // The mode-aware markup utilities must re-point, and the mode-stable
  // ones must NOT (a scrim and a white fill are mode-independent).
  check("dark: .bg-neu-sunken re-points to the dark wash",
        await utilColour("#util-sunken", "backgroundColor", "--neu-sunken"), sameColour);
  check("dark: .border-neu-hairline re-points to the light edge",
        await utilColour("#util-hairline", "borderTopColor", "--neu-hairline"), sameColour);
  check("dark: .bg-neu-scrim stays dark (mode-stable)",
        (await utilColour("#util-scrim", "backgroundColor", "--neu-scrim-rgb")).got, "rgb(51, 65, 85)");
  check("dark: .bg-neu-solid-ink stays white (mode-stable)",
        (await utilColour("#util-solid-ink", "backgroundColor", "--neu-solid-ink")).got, "rgb(255, 255, 255)");
  // The wash chip is the pair that must re-point in BOTH halves at once.
  check("dark: .bg-neu-wash-green re-points to the dark mix",
        await utilColour("#util-wash-green", "backgroundColor", "--neu-wash-green"), sameColour);
  check("dark: .text-neu-ink-green re-points to the bright ink",
        await utilColour("#util-wash-green", "color", "--neu-ink-green"), sameColour);
  check("dark: the wash chip's own ink clears AA on its own wash",
        await evalJs(contrastOfEl("#util-wash-green")), (v) => v >= 4.5);

  // The accent flips (ink goes BRIGHTER, the tint/heat fills lighten with the
  // ring) while the two solid fills stay put — they carry white ink.
  const darkAccent = await evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return { ink: g('--neu-accent-ink'), inkStrong: g('--neu-accent-ink-strong'),
             line: g('--neu-accent-line'), solid: g('--neu-accent-solid'),
             solidStrong: g('--neu-accent-solid-strong'), wash: g('--neu-accent-wash') };
  })()`);
  check("dark: accent ink flips to the lighter AA cyan", [darkAccent.ink, darkAccent.inkStrong].join("/"), "#22d3ee/#67e8f9");
  check("dark: accent line follows the brightened ring", darkAccent.line, "#22d3ee");
  check("dark: accent solids stay put (they hold white ink)",
        [darkAccent.solid, darkAccent.solidStrong].join("/"), "#0e7490/#155e75");

  // The washes re-derive from --neu-bg with NO `.dark` override at all — the
  // color-mix is evaluated against the flipped surface, so the tint follows
  // automatically. That is the property that lets a status chip drop its
  // `dark:` twin entirely, so it is asserted rather than assumed.
  for (const hue of ["cyan", "green", "amber", "red"]) {
    check(`dark: --neu-wash-${hue} re-derives (no override needed)`,
          (await evalJs(resolveToken(`--neu-wash-${hue}`))) !== washLight[hue], true);
    check(`dark: --neu-wash-${hue} is still 8% of its accent in --neu-bg`,
          await evalJs(`(${resolveToken(`--neu-wash-${hue}`)}) === (${colourExpr(`color-mix(in srgb, var(--neu-accent-${hue}) 8%, var(--neu-bg))`)})`),
          true);
    check(`dark AA ${hue} ink on --neu-wash-${hue} >= 4.5:1`,
          await evalJs(contrastExpr(`--neu-ink-${hue}`, `--neu-wash-${hue}`)), (v) => v >= 4.5);
  }
  check("dark: the wash re-derives from the dark surface",
        darkAccent.wash, has("--neu-focus-ring") && has("--neu-bg") && has("color-mix"));
  for (const [name, token] of [["accent ink", "--neu-accent-ink"], ["accent ink-strong", "--neu-accent-ink-strong"]]) {
    check(`dark AA ${name} on --neu-bg >= 4.5:1`, await evalJs(contrastExpr(token, "--neu-bg")), (v) => v >= 4.5);
  }
  check("dark AA accent ink on --neu-accent-wash >= 4.5:1",
        await evalJs(contrastExpr("--neu-accent-ink", "--neu-accent-wash")), (v) => v >= 4.5);
  check("dark AA accent line on --neu-bg >= 3:1",
        await evalJs(contrastExpr("--neu-accent-line", "--neu-bg")), (v) => v >= 3);
  check("dark: .text-neu-accent-ink re-points",
        await utilColour("#util-accent-ink", "color", "--neu-accent-ink"), sameColour);
  check("dark: .bg-neu-accent-solid stays put (mode-stable)",
        await utilColour("#util-accent-solid", "backgroundColor", "--neu-accent-solid"), sameColour);
  await evalJs(`document.documentElement.classList.remove('dark'); document.getElementById('audit-no-transition')?.remove()`);

  // ══════════════ page surfaces (phase 2 — migrated onto the tokens) ══════════════
  const routeNode = await evalJs(cssOf("div.inv-route-node", ["background-color", "box-shadow", "color", "border-radius"]));
  check("surfaces: .inv-route-node is a recessed chip", routeNode["box-shadow"], (v) => v.includes("inset") && v.includes("rgb(186, 190, 204)") && v.includes("rgb(255, 255, 255)"));
  check("surfaces: .inv-route-node surface is --neu-bg", routeNode["background-color"], "rgb(230, 236, 240)");
  check("surfaces: .inv-route-node radius = --neu-radius-full", routeNode["border-radius"], "9999px");
  check("surfaces: .inv-route-node ink is primary", routeNode.color, "rgb(51, 65, 85)");

  const emptyState = await evalJs(`(() => {
    const cs = (s) => getComputedStyle(document.querySelector(s));
    return { iconBg: cs("div.inventory-empty-icon").backgroundColor,
             iconShadow: cs("div.inventory-empty-icon").boxShadow,
             iconInk: cs("div.inventory-empty-icon").color,
             svgInk: cs("div.inventory-empty-icon svg").color,
             title: cs("p.inventory-empty-title").color,
             desc: cs("p.inventory-empty-desc").color };
  })()`);
  check("surfaces: .inventory-empty-icon is a recessed chip", emptyState.iconShadow, (v) => v.includes("inset"));
  check("surfaces: .inventory-empty-icon surface is --neu-bg", emptyState.iconBg, "rgb(230, 236, 240)");
  check("surfaces: .inventory-empty icon + svg ink is muted", emptyState.iconInk + "/" + emptyState.svgInk, "rgb(71, 85, 105)/rgb(71, 85, 105)");
  check("surfaces: .inventory-empty-title is primary ink", emptyState.title, "rgb(51, 65, 85)");
  check("surfaces: .inventory-empty-desc is muted ink", emptyState.desc, "rgb(71, 85, 105)");

  const transfer = await evalJs(cssOf("div.inventory-transfer-card", ["background-color", "box-shadow", "border-radius", "border-top-width"]));
  check("surfaces: .inventory-transfer-card is raised", transfer["box-shadow"], (v) => v.includes("3px 3px 7px") && !v.includes("inset"));
  check("surfaces: .inventory-transfer-card drops the old hairline", transfer["border-top-width"], "0px");
  check("surfaces: .inventory-transfer-card surface is --neu-bg", transfer["background-color"], "rgb(230, 236, 240)");
  check("surfaces: .inventory-transfer-card radius = --neu-radius-md", transfer["border-radius"], "16px");

  const smart = await evalJs(`(() => {
    const el = document.querySelector("div.smart-image");
    return { bg: getComputedStyle(el).backgroundColor,
             icon: getComputedStyle(el.querySelector(".smart-image-icon")).color };
  })()`);
  const smartBlock = blockAt(css, /\.smart-image\s*\{/m, 900);
  check("surfaces: .smart-image checkerboard tints --neu-shadow-dark", smartBlock, has("color-mix(in srgb, var(--neu-shadow-dark) 45%"));
  check("surfaces: .smart-image declares no legacy surface token", smartBlock, (v) => !v.includes("--color-surface"));
  check("surfaces: .smart-image surface is --neu-bg", smart.bg, "rgb(230, 236, 240)");
  check("surfaces: .smart-image icon is muted ink", smart.icon, "rgb(71, 85, 105)");

  // The scrollbar thumb is a vendor pseudo-element with no computed-style
  // surface, so assert its declaration over the compiled CSS instead.
  // The leading (^|[\s,]) keeps this on the GLOBAL rule rather than the
  // `.pos-scroll::-webkit-scrollbar-thumb` override.
  const thumbRule = blockAt(css, /(?:^|[\s,])::-webkit-scrollbar-thumb\s*\{/m, 400);
  check("surfaces: scrollbar thumb tints --neu-shadow-dark", thumbRule, has("color-mix(in srgb, var(--neu-shadow-dark)"));
  check("surfaces: scrollbar thumb radius = --neu-radius-full", thumbRule, has("var(--neu-radius-full)"));

  // Guard the whole phase-2 migration: none of these blocks may reach
  // for a legacy surface/radius/shadow token again. Reports only the
  // offending var() names, so a pass reads as [] rather than dumping
  // the whole stylesheet.
  const MIGRATED = ["::-webkit-scrollbar-thumb", ".inv-route-node", ".inventory-empty",
                    ".inventory-transfer-card", ".smart-image"];
  const migratedCss = MIGRATED
    .flatMap((sel) => css.match(new RegExp(escapeRe(sel) + "[^{]*\\{[^}]*\\}", "g")) || [])
    .join("\n");
  const legacyRefs = [...new Set(migratedCss.match(/var\(--(?:color-surface[^)]*|radius-[^)]*|shadow-[^)]*)\)/g) || [])];
  check("surfaces: migrated blocks use no legacy token", legacyRefs, (v) => v.length === 0);

  // ══════════════ lightbox chrome — the documented exception ══════════════
  const lightbox = await evalJs(`(() => {
    const close = getComputedStyle(document.querySelector("button.lightbox-close"));
    const counter = getComputedStyle(document.querySelector("div.lightbox-counter"));
    return { bg: close.backgroundColor, ink: close.color, radius: close.borderRadius,
             shadow: close.boxShadow, counterRadius: counter.borderRadius, counterInk: counter.color };
  })()`);
  check("lightbox: chrome is white ink on a translucent fill", lightbox.ink + " " + lightbox.bg, "rgb(255, 255, 255) rgba(255, 255, 255, 0.12)");
  check("lightbox: chrome wears no emboss (deliberate)", lightbox.shadow, "none");
  check("lightbox: chrome still uses the neu radius scale", lightbox.radius + "/" + lightbox.counterRadius, "9999px/9999px");
  check("lightbox: counter ink is white", lightbox.counterInk, "rgb(255, 255, 255)");

  // The lightbox frames an image whose size it does not know, so the CAP is
  // the whole layout guarantee. Asserted against the stylesheet because the
  // seeded database has no product images to open (see Known gaps).
  {
    const frame = await evalJs(cssOf(".lightbox-frame", ["max-width", "max-height"]));
    const img = await evalJs(cssOf(".lightbox-img", ["max-height"]));
    // `vw`/`vh` resolve to a length at computed-value time, so the declaration
    // (`90vw` / `calc(90vh - 16px)`) is compared against the live viewport
    // rather than against those strings — which is also what proves the unit
    // is viewport-relative and not, say, a percentage of the parent.
    const vp = await evalJs("(() => ({ w: innerWidth, h: innerHeight }))()");
    const near = (got, want) => {
      const n = parseFloat(got ?? "");
      return Number.isFinite(n) && Math.abs(n - want) <= 0.6;
    };
    check("lightbox: the frame caps at 90vw/90vh",
          frame && `${frame["max-width"]} / ${frame["max-height"]}`,
          (v) =>
            typeof v === "string" &&
            near(v.split(" / ")[0], vp.w * 0.9) &&
            near(v.split(" / ")[1], vp.h * 0.9));
    check("lightbox: the image is capped 8px inside the frame bezel",
          img?.["max-height"], (v) => near(v, vp.h * 0.9 - 16));
  }

  // ══════════════ markup ratchet (static, no browser) ══════════════
  // The bespoke page JSX was migrated onto the neu tokens by
  // scripts/codemod-neu-markup.mjs. These counts may only go DOWN — a
  // new legacy surface token or legacy focus indicator is a regression.
  const PRINT_PAPER = [
    "src/components/products/barcode-label.tsx",
    "src/components/print/print-preview.tsx",
    // The printer-profile inspector renders receipt HTML in a sandboxed
    // iframe — its white background is paper, same as print-preview.
    "src/app/(dashboard)/settings/printers/page.tsx",
  ];
  const tsx = readdirSync("src", { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
    .map((e) => ({
      path: `${(e.parentPath ?? e.path).replace(/\\/g, "/")}/${e.name}`,
      text: readFileSync(`${e.parentPath ?? e.path}/${e.name}`, "utf8"),
    }));
  const markup = tsx.filter((f) => !PRINT_PAPER.includes(f.path));
  const offenders = (files, re) =>
    files
      .map((f) => ({ path: f.path, hits: (f.text.match(re) ?? []).length }))
      .filter((f) => f.hits > 0)
      .map((f) => `${f.path} (${f.hits})`);

  // Every usage ratchet below reads this copy: a comment that NAMES a retired
  // class is documentation, not usage. (The dead `peer-disabled:` on the Label
  // was recorded in a comment when it was removed, which is exactly the case a
  // naive scan would misread as a live class.)
  const codeTsx = tsx.map((f) => ({ path: f.path, text: f.text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") }));

  check("markup: no legacy surface token in TSX (print paper excepted)",
        offenders(markup, /\b(?:bg-white|(?:bg|text|border|divide|ring|from|to|via|shadow)-surface-\d+)\b/g),
        (v) => v.length === 0);
  check("markup: no legacy focus indicator (one neu ring instead)",
        offenders(markup, /\b(?:focus|focus-visible|focus-within)(?:-[a-z]+)?:(?:outline-none|ring-\d|ring-offset-\d|ring-(?:brand|danger|surface)-\d|border-brand-\d)/g),
        (v) => v.length === 0);
  // The `--color-brand-*` accent palette has been migrated onto the neu
  // accent tokens, so this is now a ZERO rather than a ceiling: any brand
  // accent reappearing in TSX is a regression. The palette itself stays
  // DEFINED in globals.css — print-brand.ts mirrors it and
  // tests/print-brand-sync.test.ts fails if the two drift — but nothing on
  // screen may reference it any more.
  const BRAND_ACCENT_BASELINE = 0;
  const brandAccents = tsx.reduce(
    (n, f) => n + (f.text.match(/\b(?:[a-z0-9-]+:)*[a-z-]*-brand-\d+(?:\/\d+)?/g) ?? []).length, 0);
  check(`markup: brand-accent palette does not grow (<= ${BRAND_ACCENT_BASELINE})`, brandAccents, (v) => v <= BRAND_ACCENT_BASELINE);

  // The palette itself is gone too: the accent migration and the print
  // palette both point at the neu tokens now, so re-declaring it would be
  // dead weight (and would silently re-open the hue split).
  const legacyBrandDecls = css.match(/--color-brand-\d+\s*:/g) ?? [];
  check("tokens: the legacy blue brand palette is gone from globals.css",
        legacyBrandDecls, (v) => v.length === 0);

  // Raw Tailwind palette hues (slate-500, emerald-50, …) were the LAST legacy
  // vocabulary, and they used to carry two exemptions: the bespoke clock bezel
  // and the dashboard's podium/avatar tones. Both now read neu tokens, so this
  // is a plain zero: no file in src/ may name a Tailwind palette hue at all.
  // Scanned with comments stripped, like the other usage ratchets — prose that
  // NAMES a retired class is documentation, not usage.
  const RAW_PALETTE =
    /\b(?:bg|text|border|ring|divide|from|via|to|shadow|outline|accent|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
  check("markup: no raw Tailwind palette hue anywhere in src (all migrated)",
        offenders(codeTsx, RAW_PALETTE), (v) => v.length === 0);

  // The retired brand blue (#3b82f6) written as a LITERAL inside an
  // arbitrary value is invisible to every token-based check: no `brand-*`
  // name appears, the utility compiles, and the colour looks deliberate.
  // It survives a palette migration by construction, so it needs its own
  // ratchet. (`--color-info-500: #3b82f6` stays as a DECLARED token —
  // print-brand.ts mirrors the status scale; this is about markup that
  // bypasses the token layer entirely.)
  check("markup: no retired brand-blue literal in markup (use a neu token)",
        offenders(codeTsx, /(?:rgba?\(\s*59\s*,\s*130\s*,\s*246|#3b82f6)/gi), (v) => v.length === 0);

  // The status palette (`success-50` … `info-950`) was the largest remaining
  // legacy vocabulary, and the last one that shipped a real accessibility
  // bug: its dark pair (`dark:bg-danger-500/15` + `dark:text-danger-500`)
  // scored 4.26:1. It migrated onto `bg-neu-wash-<hue>` +
  // `text-neu-ink-<hue>`, which needs no `dark:` twin at all, so referencing
  // it again is a regression. The palette stays DEFINED in globals.css —
  // print-brand.ts mirrors the file — but nothing on screen may use it, and
  // the clock's exemption is gone with its old bezel. Scanned with comments
  // stripped, because prose that NAMES a legacy class is documentation.
  const SEMANTIC_LEGACY =
    /\b(?:[a-z0-9-]+:)*(?:bg|text|border|divide|ring|from|via|to|shadow|outline|accent|fill|stroke)-(?:success|warning|danger|info)-\d{2,3}(?:\/\d+)?/g;
  check("markup: no legacy status palette anywhere in src",
        offenders(codeTsx, SEMANTIC_LEGACY), (v) => v.length === 0);
  // The same palette reached the chart/series configs through
  // `var(--color-<semantic>-500)` — a form that carries no utility name for
  // the scan above to catch. Series fills are drawn ON the page background,
  // so they take the mode-aware `--neu-ink-*` roles: a `--neu-solid-*` fill is
  // tuned for a white glyph on TOP of it and only scores 2.26:1 against dark
  // `--neu-bg`, which would make the series invisible in dark mode.
  check("markup: no legacy status palette via var() anywhere in src",
        offenders(codeTsx, /var\(--color-(?:success|warning|danger|info)-\d+\)/g),
        (v) => v.length === 0);
  // Chart series are the one place a mode-aware ink role MUST be used
  // instead of a mode-stable solid: a series is a graphic drawn on the page,
  // and `--neu-solid-*` is tuned for a white glyph on top of it (2.26:1 on
  // dark `--neu-bg`). Pin the distinction so a future "simplification" to the
  // solid cannot silently make every series invisible in dark mode.
  {
    const SERIES_FILES = [
      "src/app/(dashboard)/dashboard/page.tsx",
      "src/app/(dashboard)/reports/sales/page.tsx",
      "src/app/(dashboard)/reports/profit-loss/page.tsx",
      "src/app/(dashboard)/reports/inventory/page.tsx",
    ];
    // No bespoke series hue remains: the last one (`#8b5cf6`) is now the
    // audited `--neu-ink-violet` token, so every series fill is a mode-aware
    // neu ink. Left as an empty list so re-introducing a raw hex fails here.
    const SERIES_RAW_ALLOWED = [];
    const badSeries = [];
    for (const f of codeTsx.filter((x) => SERIES_FILES.includes(x.path))) {
      for (const m of f.text.match(/\bcolor\s*[:=]\s*"([^"]+)"/g) ?? []) {
        const value = m.slice(m.indexOf('"') + 1, -1);
        if (SERIES_RAW_ALLOWED.includes(value)) continue;
        const isNeu = /^var\(--neu-[a-z0-9-]+\)$/.test(value);
        const isSolid = value.startsWith("var(--neu-solid-");
        if (!isNeu || isSolid) badSeries.push(`${f.path}: ${m.trim()}`);
      }
    }
    check("series: every chart colour is a mode-aware neu token (not a solid)",
          badSeries.slice(0, 6), (v) => v.length === 0);
  }

  // ── icon vocabulary ──
  // Every icon in this app is an inline <svg>. Emoji and icon-font glyphs are
  // the two ways that rule gets broken, and an emoji is not a cosmetic slip:
  // its size, weight and baseline come from whatever font the device has, and
  // it cannot take `currentColor`, so it cannot follow the ink ladder or the
  // `.dark` override. The typographic marks are exempt — a key name in a
  // shortcut hint (`⌘`, `↵`, `↑`) is text describing a key, not an icon.
  const TYPOGRAPHIC_MARKS = /[⌘↵↑↓→←↔⇄⇒✕]/g;
  const EMOJI =
    /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
  check("markup: icons are inline SVG — no emoji anywhere in the UI",
        offenders(codeTsx.map((f) => ({ path: f.path, text: f.text.replace(TYPOGRAPHIC_MARKS, " ") })), EMOJI),
        (v) => v.length === 0);
  check("markup: no icon-font vocabulary (material-icons / glyphicon)",
        offenders(codeTsx,
          /\b(?:material-icons(?:-outlined|-round|-sharp)?|material-symbols(?:-outlined|-rounded|-sharp)?|glyphicon|font-awesome)\b/g),
        (v) => v.length === 0);

  // The four vivid accents are decoration BY DESIGN — as TEXT they score
  // 1.16 / 1.91 / 1.80 / 3.16:1 on the light surface, so every one of them
  // fails AA. `text-neu-<hue>` therefore cannot be a deliberate choice, and
  // the readable option is not a matter of taste: it is the SAME hue's ink
  // role (5.95–6.10:1). Deviation 8 stated this as policy; nothing enforced
  // it, and two call sites (a form Label's error state and the rating stars)
  // had quietly drifted onto the vivid accent.
  check("markup: no vivid accent used as text (ink roles carry meaning)",
        offenders(codeTsx, /\btext-neu-(?:cyan|green|amber|red)\b/g), (v) => v.length === 0);

  // `group-*` / `peer-*` only paint if the marker class they key off exists.
  // When it does not, the utility compiles, the selector can never match,
  // and nothing anywhere reports a problem — the exact shape of the dead
  // `peer-disabled:` that shipped on the Label. Two rules:
  //   • repo-wide — the marker must exist somewhere, so a variant cannot
  //     reference a vocabulary the codebase has no markers for at all
  //   • src/app/** — a page owns its own marker, so the affordance is
  //     self-contained rather than leaning on an ancestor it cannot see
  // The marker must be a standalone CLASS TOKEN: `\bgroup\b` would also
  // match `group-hover:` itself and make the check vacuous.
  const MARKER = { group: /[ "'`{/]group[ "'`{/]/, peer: /[ "'`{/]peer[ "'`{/]/ };
  const usedRelatives = new Set();
  for (const f of codeTsx) {
    for (const m of f.text.matchAll(/\b(group|peer)-[a-z-]+:/g)) usedRelatives.add(m[1]);
  }
  const allSrc = codeTsx.map((f) => f.text).join("\n");
  check("markup: every group-*/peer-* variant has its marker class in src",
        [...usedRelatives].filter((k) => !MARKER[k].test(allSrc)).map((k) => `no .${k} marker anywhere in src`),
        (v) => v.length === 0);
  check("markup: each page owns the group/peer marker its variants key off",
        codeTsx
          .filter((f) => f.path.startsWith("src/app/"))
          .filter((f) => [...new Set([...f.text.matchAll(/\b(group|peer)-[a-z-]+:/g)].map((m) => m[1]))]
            .some((k) => !MARKER[k].test(f.text)))
          .map((f) => f.path),
        (v) => v.length === 0);

  // ══════════════ motion vs layout transform (static) ══════════════
  // Tailwind v4 emits `translate-x-*` as the modern `translate` PROPERTY, not
  // as a `transform`. The two COMPOSE instead of overriding, so a keyframe
  // that sets `transform: translate(...)` on an element holding a
  // `translate-*` utility applies its offset on top of the utility's — the
  // movement is silently doubled. That is precisely how every dialog shipped
  // offset by half its own width up and to the left (only the pages audit's
  // geometry measurement caught it, and only once it was run).
  //
  // Only TRANSLATE is flagged. A keyframe's `scale()`/`rotate()` composing
  // with the `scale`/`rotate` utilities is multiplicative/additive and almost
  // always intended; a doubled translate is never anything but a bug.
  const translateKeyframes = new Set(
    [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)]
      .filter((m) => /transform\s*:[^;]*translate/.test(m[2]))
      .map((m) => m[1])
  );
  // Motion reaches an element by two routes, and both must be followed:
  // an `animate-<name>` utility, or a recipe class that declares `animation:`.
  const recipeMotion = new Map();
  for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const a = m[2].match(/\banimation\s*:\s*([\w-]+)/);
    if (a) recipeMotion.set(m[1], a[1]);
  }
  const TRANSLATE_UTIL = /(?:^|[\s:])-?translate-[xy]?[\w[\]/.%()-]+/;
  /** Class strings belonging to ONE element. A `cn(...)` call is one group —
      without that, `cn("translate-x-[-50%]", "neu-dialog-panel")` reads as
      two unrelated elements and the conflict hides in plain sight. */
  const classGroups = (text) => {
    const calls = [];
    for (const m of text.matchAll(/\b(?:cn|cva|clsx|classNames)\s*\(/g)) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) break;
      }
      calls.push([m.index, i + 1]);
    }
    const inner = (idx) => calls.some(([a, b]) => idx >= a && idx < b);
    const quoted = (s) => s.match(/"[^"\n]*"/g)?.join(" ") ?? "";
    const groups = calls.map(([a, b]) => quoted(text.slice(a, b)));
    for (const m of text.matchAll(/"[^"\n]*"/g)) if (!inner(m.index)) groups.push(m[0]);
    return groups;
  };
  const motionConflicts = new Set();
  for (const f of codeTsx) {
    for (const group of classGroups(f.text)) {
      const toks = group.replace(/"/g, "").split(/\s+/).filter(Boolean);
      if (!toks.some((t) => TRANSLATE_UTIL.test(" " + t + " "))) continue;
      const anims = toks
        .map((t) => (t.startsWith("animate-") ? t.slice(8) : recipeMotion.get(t)))
        .filter((a) => a && translateKeyframes.has(a));
      if (anims.length) motionConflicts.add(`${f.path}: ${[...new Set(anims)].join("+")} animates a translate the element also sets`);
    }
  }
  check("motion: no keyframe translate doubles an element's own translate-* utility",
        [...motionConflicts].slice(0, 6), (v) => v.length === 0);

  // `vh` includes the mobile URL bar, so a `max-h-[80vh]` panel/sheet gets
  // its last ~10% — the footer — clipped with no way to scroll to it. Every
  // viewport-relative size in this app must be `dvh`.
  check("layout: no vh-based sizing in TSX (dvh only)", offenders(tsx, /\[[^\]]*\d+vh\]/g), (v) => v.length === 0);

  // ══════════════ dialog layout contract (static) ══════════════
  // These classes ARE the fix for the "footer cut off / body unscrollable"
  // bug class, so they are asserted rather than trusted. Geometry is
  // separately measured on real pages by audit-neu-pages.mjs.
  const dialogSrc = readFileSync("src/components/ui/dialog.tsx", "utf8");
  const dlgContent = dialogSrc.slice(dialogSrc.indexOf("const DialogContent"), dialogSrc.indexOf("function DialogHeader"));
  const dlgBody = dialogSrc.slice(dialogSrc.indexOf("function DialogBody"), dialogSrc.indexOf("function DialogFooter"));
  const dlgChrome = dialogSrc.slice(dialogSrc.indexOf("function DialogHeader"), dialogSrc.indexOf("function DialogTitle")) +
    dialogSrc.slice(dialogSrc.indexOf("function DialogFooter"), dialogSrc.indexOf("export {"));
  check("dialog: panel clamps to the VISIBLE viewport (dvh, not vh)",
        dlgContent, has("max-h-[calc(100dvh-2rem)]"));
  check("dialog: panel never exceeds the screen width", dlgContent, has("w-[calc(100vw-2rem)]"));
  check("dialog: panel is a clipping flex column", dlgContent,
        (v) => v.includes("flex flex-col") && v.includes("overflow-hidden"));
  check("dialog: panel is the neu surface + neu focus ring", dlgContent,
        (v) => v.includes("neu-dialog-panel") && v.includes("neu-card-flush") && v.includes("neu-focus"));
  check("dialog: body is the ONLY scroll region (min-h-0 + flex-1 + overflow-y-auto)",
        dlgBody, (v) => v.includes("min-h-0") && v.includes("flex-1") && v.includes("overflow-y-auto"));
  check("dialog: header + footer are pinned (shrink-0)",
        dlgChrome, (v) => (v.match(/shrink-0/g) ?? []).length >= 2);
  check("dialog: overlay uses the shared scrim recipe", dialogSrc, has("neu-dialog-overlay"));
  check("dialog: a bare Button can no longer submit its form by accident",
        readFileSync("src/components/ui/button.tsx", "utf8"), has('type={props.type ?? "button"}'));

  // ══════════════ shell chrome contract (static) ══════════════
  // The bar, the rail and the clock are the only surfaces on EVERY page, and
  // they are exactly what a page audit samples least: the rail's rows are
  // shared chrome, and the overlay hunt deliberately sorts page-local triggers
  // first. So the chrome's own contract is asserted here instead.
  const shellSrc = readFileSync("src/app/(dashboard)/layout.tsx", "utf8");
  check("chrome: both nav landmarks are named (rail + drawer)",
        (shellSrc.match(/<nav\s+aria-label=/g) ?? []).length, (v) => v >= 2);
  check("chrome: the rail marks the current page for assistive tech",
        shellSrc, has('aria-current={active ? "page" : undefined}'));
  check("chrome: the rail's toggle names the action it performs (collapsed too)",
        shellSrc, (v) => v.includes('t("nav.expand")') && v.includes('t("nav.collapse")'));
  check("chrome: the palette is reachable below `lg` (the well is lg-only)",
        (shellSrc.match(/setSearchOpen\(true\)/g) ?? []).length, (v) => v >= 2);
  check("chrome: the search well is a real flex child (min-w-0, not a min-content floor)",
        shellSrc, (v) => /hidden h-9 min-w-0 max-w-md flex-1[^"]*lg:flex/.test(v));
  check("chrome: the rail is icon-only below `lg` (width is width-gated, not state-gated)",
        shellSrc, has('sidebarCollapsed ? "w-[72px]" : "w-[72px] lg:w-[260px]"'));
  check("chrome: the rail's labels collapse with the WIDTH, not only with the preference",
        shellSrc, (v) => v.includes("truncate max-lg:hidden") && v.includes("max-lg:justify-center"));
  check("chrome: collapsing the rail widens the content measure (the freed 188px is used)",
        shellSrc, (v) => v.includes('sidebarCollapsed ? "max-w-[1600px]" : "max-w-7xl"'));
  check("chrome: a skip link exists and targets a programmatically focusable <main>",
        shellSrc,
        (v) => v.includes('href="#main-content"') && v.includes('id="main-content"') && v.includes("tabIndex={-1}"));
  check("chrome: the rail names itself to the footer with the build it is running",
        shellSrc, (v) => v.includes("APP_VERSION") && /\{APP_NAME\} v\{APP_VERSION\}/.test(v));

  // ── RTL ──
  // `dir` becomes rtl for Urdu, so a physical `left-0` in the shell is a bug
  // waiting for a language switch: the rail would stay where the reading
  // direction does not put it, and `-translate-x-full` would push the CLOSED
  // drawer INTO the viewport. Asserted statically here and measured at runtime
  // in the pages audit (rail side, drawer edge, cluster order).
  // Physical HORIZONTAL anchoring only: `top-3`/`bottom-4` are direction-neutral
  // and `translate-x-0` is the open state of a drawer that is correct in both
  // directions. A `left-0`, a `mr-3` or a `text-left` is not.
  // Scanned with comments stripped, like every other usage ratchet: prose that
  // NAMES the retired class (`start-0`, not `left-0`) is documentation.
  const shellCode = shellSrc
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const stripComments = (p) =>
    readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  check("chrome: the shell anchors on logical edges only (RTL-safe)",
        offenders([{ path: "src/app/(dashboard)/layout.tsx", text: shellCode }],
          /\b(?:left|right)-(?:\d|\[)|(?:^|[\s"'`])(?:m[lr]|p[lr])-|\btext-(?:left|right)\b/g),
        (v) => v.length === 0);
  check("chrome: the closed drawer is pushed off BOTH edges, in rtl too",
        shellSrc, has("-translate-x-full rtl:translate-x-full"));
  check("chrome: the toast + sync stacks dock to the trailing edge",
        offenders(
          ["src/components/ui/toaster.tsx", "src/components/layout/sync-indicator.tsx"]
            .map((p) => ({ path: p, text: stripComments(p) })),
          /\b(?:left|right)-\d/g
        ),
        (v) => v.length === 0);

  // ── direction, repo-wide ──
  // The shell checks above are named-file spot checks with a loose pattern.
  // This is the whole repository, with the precise vocabulary that
  // scripts/codemod-neu-logical.mjs rewrites — so a new `ml-2`, `text-right`
  // or `rounded-l-lg` anywhere in the UI fails the build instead of waiting for
  // someone to switch the language and notice a row of controls reversed.
  //
  // The value anchor is the point: `rounded-l` is a side, `rounded-lg` is a
  // radius SIZE, and `border-radius` is CSS — none of the last two may be
  // rewritten. Likewise `align: "right"` in a print-column config is not a
  // utility and is not matched.
  const PHYSICAL_DIRECTION = new RegExp(
    `(^|[\\s"'\`])(?:[a-z0-9.[\\]%-]+:)*(?:-?m[lr]-(?:[\\d.]+|px|auto|full|screen|min|max|fit|\\[[^\\]]+\\])|-?p[lr]-(?:[\\d.]+|px|auto|full|screen|min|max|fit|\\[[^\\]]+\\])|-?(?:left|right)-(?:[\\d.]+|px|auto|full|\\d+\\/\\d+|\\[[^\\]]+\\])|text-(?:left|right)|border-[lr](?![a-z])|rounded-(?:tl|tr|bl|br|l|r)(?![a-z])|float-(?:left|right))(?![\\w-])`,
    "g"
  );
  /* Physical direction utilities are allowed in exactly these places, each for a
     stated reason; everywhere else (and every other token) is a regression. The
     list is short because the exemptions are narrow: an LTR island declares
     `dir` and then uses LOGICAL utilities inside it (they resolve against the
     island's own direction), so only the two genuinely direction-NEUTRAL cases
     need naming here. */
  const PHYSICAL_ALLOWED = {
    // `left-[50%]` + `-translate-x-[-50%]` is a SYMMETRIC centering, not a
    // direction: translating one half and not the other breaks both scripts.
    "src/components/ui/dialog.tsx": ["left-[50%]"],
  };
  const directionLeftovers = [];
  for (const f of codeTsx) {
    if (PRINT_PAPER.includes(f.path)) continue;
    const allowed = PHYSICAL_ALLOWED[f.path] ?? [];
    const tokens = (f.text.match(PHYSICAL_DIRECTION) ?? [])
      .map((h) => h.trim().replace(/^[^a-z-[\]]+/, ""))
      .filter((t) => !allowed.includes(t));
    if (tokens.length) directionLeftovers.push(`${f.path} (${[...new Set(tokens)].join(" ")})`);
  }
  check("direction: nothing outside an LTR island uses a physical direction utility",
        directionLeftovers, (v) => v.length === 0);

  /* The exemptions above stay honest only while the islands that justify them
     really are islands. A `dir="ltr"` is a directional claim, so it is named
     here too: a new one is a design decision, not a detail. */
  const LTR_ISLANDS = {
    "src/components/layout/live-clock.tsx": "the clock's digits and AM/PM",
    "src/app/(dashboard)/pos/page.tsx": "the receipt facsimile",
    "src/app/(dashboard)/settings/receipts/page.tsx": "the receipt facsimile",
  };
  const islandFiles = codeTsx.filter((f) => /\bdir="ltr"/.test(f.text)).map((f) => f.path);
  check("direction: the only LTR islands are the clock and the print facsimiles",
        islandFiles,
        (v) => v.every((p) => LTR_ISLANDS[p]) && Object.keys(LTR_ISLANDS).every((p) => v.includes(p)));
  /* globals.css is not scanned by the codemod (it rewrites class strings, not
     declarations), so its physical properties are pinned here instead. Two are
     deliberate and are subtracted before the verdict:
       • `.neu-separator-v`'s two-line emboss — that is a LIGHT edge and a lit
         edge, and a light source is a property of the room (same rule as the
         un-mirrored emboss);
       • `.lightbox-counter`'s `left: 50%` — paired with
         `transform: translateX(-50%)`, i.e. a symmetric centering that should
         read the same in both directions, exactly like the dialog's. */
  const cssDirection = readFileSync("src/app/globals.css", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/border-(?:left|right):\s*1px solid var\(--neu-shadow-(?:dark|light)\);/g, " ")
    .replace(/left:\s*50%;\s*transform:\s*translateX\(-50%\);/g, " ");
  check("direction: no physical layout property in globals.css (light edges excepted)",
        [
          ...(cssDirection.match(/(^|[;{\s])(?:left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/g) ?? []),
          // `text-align: center` is direction-neutral, so only the edges count
          ...(cssDirection.match(/text-align:\s*(?:left|right)\b/g) ?? []),
        ],
        (v) => v.length === 0);

  check("direction: an island says why it does not follow the UI",
        islandFiles.map((p) => `${p} \u2192 ${/LTR island|facsimile/i.test(readFileSync(p, "utf8")) ? "explained" : "MISSING RATIONALE"}`),
        (v) => v.every((x) => !x.endsWith("MISSING RATIONALE")));

  // ── the bar's lift ──
  // The bar's lift is a TOKEN, not an inline pair: the shadow-offsets ratchet
  // below ("never re-typed inline") would otherwise fire, correctly.
  check("chrome: the bar's scrolled state is a token-driven recipe",
        readFileSync("src/app/globals.css", "utf8"),
        (v) => /\.neu-bar-lifted\s*\{[^}]*box-shadow:\s*var\(--neu-shadow-bar\)/.test(v));
  check("chrome: the bar's lift token is downward-only (a lid, not a card)",
        readFileSync("src/app/globals.css", "utf8"),
        (v) => /--neu-shadow-bar:\s*0 \d+px \d+px/.test(v) && !/--neu-shadow-bar:[^;]*-\d+px -\d+px/.test(v));
  check("chrome: the rail's primary action is the one filled control",
        shellCode, (v) => v.includes("bg-neu-accent-solid") && v.includes("text-neu-solid-ink"));

  // Two interactive elements for one action is a classic: the outer one takes
  // the focus and the inner one has nothing to announce. It survived every
  // colour and geometry check because it is a SHAPE problem.
  check("markup: no <Button> nested inside a link (one action, one control)",
        offenders(codeTsx, /<a\b[^>]*>\s*<Button/g), (v) => v.length === 0);

  // The clock swaps form with the width rather than shrinking: a dial alone
  // says nothing at a glance, and a full readout does not fit a tablet bar.
  // Both halves have to exist, and the value must survive the swap.
  const clockSrc = readFileSync("src/components/layout/live-clock.tsx", "utf8");
  check("chrome: the clock keeps a readout below `xl` and the dial above it",
        clockSrc, (v) => v.includes("xl:hidden") && v.includes("xl:flex") && v.includes("hidden xl:block"));
  check("chrome: the clock states its value in words at every width",
        clockSrc, (v) => v.includes('role="group"') && v.includes("aria-label={now ? now.toLocaleString(localeStr) : undefined}"));

  // The page-surface half of the same contract: a breadcrumb trail is a list
  // of steps, and the last step is where you already are.
  const pageHeaderSrc = readFileSync("src/components/layout/page-header.tsx", "utf8");
  check("chrome: the breadcrumb is a labelled nav over an ordered list",
        pageHeaderSrc, (v) => v.includes('aria-label={t("nav.breadcrumb")}') && v.includes("<ol"));
  check("chrome: the current breadcrumb carries aria-current, like the rail row does",
        pageHeaderSrc, (v) => v.includes('aria-current={current ? "page" : undefined}'));
  {
    // An icon-only control is `<button>` content that renders NOTHING but an
    // <svg>. Those must carry a name — `aria-label`/`aria-labelledby`, or a
    // `title` as the last-resort fallback — because a glyph has no text for
    // assistive tech to read. The shortcuts modal's ✕ had neither.
    const unnamed = [];
    const src = shellSrc
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const [, attrs, inner] = m;
      if (/aria-label|aria-labelledby|\btitle=/.test(attrs)) continue;
      const bare = inner
        .replace(/<svg[\s\S]*?<\/svg>/g, " ")
        .replace(/<svg[^>]*\/>/g, " ")
        .replace(/<[^>]*>/g, " ")
        .trim();
      if (bare.length === 0) unnamed.push(`${attrs.trim().slice(0, 60)} …`);
    }
    check("chrome: every icon-only control in the shell declares an accessible name",
          unnamed, (v) => v.length === 0);
  }

  // Every `*-neu-*` utility the markup references must actually COMPILE.
  // Tailwind emits nothing for an unknown class and reports no error, so a
  // single typo anywhere in the migrated JSX would otherwise ship a dead
  // class silently — this is the check that makes the migration safe.
  const referencedNeu = new Set();
  for (const f of tsx) {
    // The base must START with a letter, which excludes CSS custom
    // properties (`var(--neu-bg)`) and comments mentioning `--neu-ink-*`.
    for (const m of f.text.matchAll(/(?:^|[\s"'`{])((?:[a-z0-9-]+:)*[a-z][a-z0-9-]*-neu-[a-z0-9-]+(?:\/\d+)?)/g)) {
      referencedNeu.add(m[1]);
    }
  }
  const escapeClass = (name) => name.replace(/([:/.%[\]()#!+~&*'"=<>,])/g, "\\$1");
  const missingNeu = [...referencedNeu].filter((name) => !css.includes("." + escapeClass(name))).sort();
  check(`markup: all ${referencedNeu.size} referenced neu utilities compile`, missingNeu, (v) => v.length === 0);

  // ══════════════ golden (third theme) ══════════════
  // Golden is a first-class surface keyed off `html.golden` (and
  // `html.dark.golden`) — not a tint of Neu. The RAW --neu-* tokens are
  // re-pointed through the --gold-* palette, so every shared recipe
  // re-derives. These checks prove that resolution in a real engine, and
  // that the theme stays scoped (no leakage into Neu light/dark).
  //
  // WCAG: every Golden pairing clears AA — the ink ladder, the accent
  // graphics (>= 3:1), the focus ring, the mode-stable solid fills, and the
  // gold-gradient CTA (one mode-stable ink, asserted against EVERY gradient
  // stop). See docs/GOLDEN-ELITE.md for the full per-pairing table.
  const golden = await evalJs(`(() => {
    const kill = document.createElement('style');
    kill.id = 'audit-no-transition';
    kill.textContent = '* { transition: none !important; }';
    document.head.appendChild(kill);
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('golden');
    const g = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const btn = document.createElement('button');
    btn.className = 'neu-btn neu-btn-solid';
    btn.textContent = 'CTA';
    document.body.appendChild(btn);
    const grain = document.createElement('div');
    grain.id = 'audit-grain';
    grain.className = 'golden-grains';
    document.body.appendChild(grain);
    const btnCs = getComputedStyle(btn);
    const grainCs = getComputedStyle(grain);
    const cardAfter = getComputedStyle(document.querySelector('div.neu-card'), '::after');
    return {
      goldBg: g('--gold-bg'), rawBg: g('--neu-bg'), rawInkCyan: g('--neu-ink-cyan'),
      colorPrimary: g('--color-neu-primary'), text: g('--gold-text-primary'),
      body: getComputedStyle(document.body).backgroundColor,
      btnBg: btnCs.backgroundImage, btnColor: btnCs.color,
      cardAfterBg: cardAfter.backgroundImage, sheen: g('--neu-sheen-gradient'),
      grainOpacity: grainCs.opacity, grainPosition: grainCs.position,
    };
  })()`);
  check("golden: --gold-bg is the warm light surface", golden.goldBg, "#fbf6ec");
  check("golden: RAW --neu-bg re-points (recipes, not just utilities)", golden.rawBg, "#fbf6ec");
  check("golden: RAW --neu-ink-cyan re-points to gold ink", golden.rawInkCyan, "#6a4f16");
  check("golden: --color-neu-primary alias re-points", golden.colorPrimary, "#3b2f1c");
  check("golden: body surface follows the palette", golden.body, "rgb(251, 246, 236)");
  check("golden: primary CTA paints the gold gradient (sheen site 1)", golden.btnBg, has("linear-gradient"));
  check("golden: primary CTA ink is the mode-stable --gold-on-gold", golden.btnColor, "rgb(59, 47, 28)");
  check("golden: .neu-card::after carries the sheen (site 2)", golden.cardAfterBg, has("linear-gradient"));
  check("golden: --neu-sheen-gradient resolves", golden.sheen, has("linear-gradient"));
  check("golden: grain overlay is fixed + near-invisible", golden.grainPosition + "/" + golden.grainOpacity, "fixed/0.03");

  // Scoping: with `golden` removed the palette is undefined and the grain
  // rule does not apply — the theme cannot leak into Neu light/dark.
  const goldenScope = await evalJs(`(() => {
    document.documentElement.classList.remove('golden');
    const g = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const grain = getComputedStyle(document.getElementById('audit-grain'));
    return { goldBg: g('--gold-bg'), grainOpacity: grain.opacity, grainPosition: grain.position };
  })()`);
  check("golden: palette undefined outside .golden (no leakage)", goldenScope.goldBg, "");
  check("golden: grain rule inert outside .golden", goldenScope.grainPosition + "/" + goldenScope.grainOpacity, "static/1");

  // WCAG, measured in-engine for Golden light (the pairs that clear AA).
  await evalJs(`document.documentElement.classList.add('golden')`);
  for (const [name, token] of [["primary", "--gold-text-primary"], ["muted", "--gold-text-muted"], ["faint", "--gold-text-faint"], ["ink-gold", "--gold-ink-gold"], ["ink-red", "--gold-ink-red"]]) {
    check(`golden AA ${name} on --gold-bg >= 4.5:1`, await evalJs(contrastExpr(token, "--gold-bg")), (v) => v >= 4.5);
  }
  check("golden AA accent ink on accent wash >= 4.5:1",
        await evalJs(contrastExpr("--gold-accent-ink", "--gold-accent-wash")), (v) => v >= 4.5);
  check("golden AA focus ring on --gold-bg >= 3:1",
        await evalJs(contrastExpr("--gold-focus-ring", "--gold-bg")), (v) => v >= 3);
  // Decorative accents must still clear 3:1 as GRAPHICS on the surface.
  for (const [name, token] of [["gold", "--gold-accent-gold"], ["green", "--gold-accent-green"], ["amber", "--gold-accent-amber"], ["red", "--gold-accent-red"]]) {
    check(`golden graphic AA accent-${name} on --gold-bg >= 3:1`, await evalJs(contrastExpr(token, "--gold-bg")), (v) => v >= 3);
  }
  // The gold-gradient CTA: ONE mode-stable ink must clear AA across EVERY
  // declared stop (the darkest stop is the binding constraint).
  for (const [i, stop] of ["#f3e0a4", "#ddbb62", "#c9a24b"].entries()) {
    check(`golden AA: --gold-on-gold on gold-gradient stop ${i + 1} >= 4.5:1`,
          await evalJs(contrastBetween(tokenOf("--gold-on-gold"), JSON.stringify(stop))), (v) => v >= 4.5);
  }

  // Golden dark: the palette flips, the raw tokens re-derive automatically.
  const goldenDark = await evalJs(`(() => {
    document.documentElement.classList.add('dark');
    const g = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return { goldBg: g('--gold-bg'), rawBg: g('--neu-bg'), text: g('--gold-text-primary'),
             body: getComputedStyle(document.body).backgroundColor };
  })()`);
  check("golden dark: surface flips", goldenDark.goldBg + "/" + goldenDark.rawBg, "#241d14/#241d14");
  check("golden dark: body surface follows", goldenDark.body, "rgb(36, 29, 20)");
  for (const [name, token] of [["primary", "--gold-text-primary"], ["muted", "--gold-text-muted"], ["faint", "--gold-text-faint"], ["ink-gold", "--gold-ink-gold"], ["ink-red", "--gold-ink-red"]]) {
    check(`golden dark AA ${name} on --gold-bg >= 4.5:1`, await evalJs(contrastExpr(token, "--gold-bg")), (v) => v >= 4.5);
  }
  check("golden dark AA focus ring on --gold-bg >= 3:1",
        await evalJs(contrastExpr("--gold-focus-ring", "--gold-bg")), (v) => v >= 3);
  // The solid fills are mode-stable, so the white ink that sits on them must
  // clear AA in dark Golden exactly as it does in light.
  for (const [name, token] of [["gold", "--gold-solid-gold"], ["brass", "--gold-solid-brass"], ["amber", "--gold-solid-amber"], ["red", "--gold-solid-red"]]) {
    check(`golden dark AA: solid-ink on --gold-solid-${name} >= 4.5:1`,
          await evalJs(contrastBetween(tokenOf("--gold-solid-ink"), tokenOf(token))), (v) => v >= 4.5);
  }
  await evalJs(`document.documentElement.classList.remove('golden','dark'); document.getElementById('audit-no-transition')?.remove(); document.querySelectorAll('button.neu-btn-solid').forEach(b => b.remove()); document.getElementById('audit-grain')?.remove()`);

  // ══════════════ prefers-reduced-motion ══════════════
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const rm = await evalJs(`(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      token: root.getPropertyValue('--neu-transition').trim(),
      shimmer: getComputedStyle(document.querySelector('.neu-skeleton'), '::after').animationName,
      toast: getComputedStyle(document.querySelector('.neu-toast')).animationName,
      swap: getComputedStyle(document.querySelector('.is-success')).animationName,
    };
  })()`);
  check("reduced-motion: --neu-transition is 0ms", rm.token, "0ms");
  check("reduced-motion: shimmer disabled", rm.shimmer, "none");
  check("reduced-motion: toast slide disabled", rm.toast, "none");
  check("reduced-motion: status swap disabled", rm.swap, "none");
  await send("Emulation.setEmulatedMedia", { features: [] });

  // ══════════════ prefers-contrast: more ══════════════
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-contrast", value: "more" }] });
  const hc = await evalJs(`(() => {
    const root = getComputedStyle(document.documentElement);
    return { primary: root.getPropertyValue('--neu-text-primary').trim(), muted: root.getPropertyValue('--neu-text-muted').trim(),
             faint: root.getPropertyValue('--neu-text-faint').trim() };
  })()`);
  check("prefers-contrast: primary darkened further", hc.primary, "#1e293b");
  check("prefers-contrast: muted darkened further", hc.muted, "#334155");
  // If faint did NOT darken here the ladder would invert: faint would stay
  // at 4.83:1 while muted jumped to 8.69:1.
  check("prefers-contrast: faint darkened too (ladder kept)", hc.faint, "#475569");
  {
    const hcLadder = [];
    for (const t of ["--neu-text-primary", "--neu-text-muted", "--neu-text-faint"]) {
      hcLadder.push(await evalJs(contrastExpr(t, "--neu-bg")));
    }
    check("prefers-contrast ladder stays ordered + AA",
          hcLadder[0] > hcLadder[1] && hcLadder[1] > hcLadder[2] && hcLadder.every((v) => v >= 4.5),
          true);
  }
  await send("Emulation.setEmulatedMedia", { features: [] });

  console.log(out.join("\n"));
  console.log("\n" + (failures ? failures + " CHECK(S) FAILED" : "ALL " + out.length + " CHECKS PASSED"));
})()
  .catch((e) => { console.error("AUDIT ERROR:", e.message); failures = 1; })
  .finally(() => {
    try { ws?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    setTimeout(() => process.exit(failures ? 1 : 0), 300);
  });
