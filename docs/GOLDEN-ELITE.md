# Golden Elite — Theme Reference

Golden Elite is the **third** surface in the Elite POS design system, alongside
Neu Light and Neu Dark. It is a *first-class theme*, not a gold-tinted Neu: the
scoping contract, token surface, recipes, shadow pair, focus ring and
accessibility branches all mirror Neu, and the shared recipes re-derive from a
warm gold palette instead of the blue-grey one.

- Selector source of truth: [`src/components/providers/theme-provider.tsx`](../src/components/providers/theme-provider.tsx)
- Token + recipe source of truth: [`src/app/globals.css`](../src/app/globals.css)
- Live verification: `npm run audit:neu` (real PostCSS + Tailwind v4 + headless Chrome over CDP)

---

## 1. Scoping contract

The theme provider toggles classes on `<html>`:

| `theme`      | `<html>` class | Rendered surface |
| ------------ | -------------- | ---------------- |
| `light`      | `light`        | Neu Light        |
| `dark`       | `dark`         | Neu Dark         |
| `system`     | resolved `light`/`dark` | Neu Light / Dark |
| `golden`     | `golden`       | Golden Light     |

The saved choice persists under the `elite-pos-theme` key. `layout.tsx`'s inline
`ThemeInit` script applies `golden` (or `dark`/`light`) **before first paint**, so
a cold load no longer flashes Neu light; the provider then keeps it in sync.

> **Dark Golden (`html.dark.golden`)** is fully implemented and asserted by the
> audit, but is **not currently reachable from the theme picker** — the provider
> sets `golden` *instead of* a light/dark resolution, so `dark` is never added
> alongside it. It exists for a future "Golden Dark" option and for correctness
> of the token model; the CSS is ready if that option is added.

Every Golden rule is gated under `:root.golden`, `.dark.golden` and `.golden …`.
Nothing is written at the top level, so Neu Light/Dark are untouched:

```
PASS  golden: palette undefined outside .golden (no leakage)  ""
PASS  golden: grain rule inert outside .golden                "static/1"
```

---

## 2. Two token layers (why both are re-pointed)

| Layer | Names | Read by |
| ----- | ----- | ------- |
| Raw tokens | `--neu-bg`, `--neu-text-*`, `--neu-ink-*`, `--neu-accent-*`, `--neu-solid-*`, `--neu-wash-*`, `--neu-hairline`, `--neu-sunken`, `--neu-*-rgb`, `--neu-focus-*` | the shared **recipes** (`.neu-card`, `.neu-btn`, `.neu-input`, `body`, status washes) |
| Alias tokens | `--color-neu-*` (registered in `@theme`) | Tailwind **utilities** (`bg-neu-bg`, `text-neu-muted`, …) |

A theme that re-points only the aliases tints the utility classes but leaves the
actual surfaces (card, button, input, body) on the blue-grey Neu palette.
`:root.golden` therefore maps **both** layers through the `--gold-*` palette.
Because the raw layer resolves *through* `--gold-*`, `.dark.golden` only redefines
the `--gold-*` palette and everything re-derives.

---

## 3. Token reference

### 3.1 Surface / ink ladder

| Token | Light Golden | Dark Golden | Purpose |
| ----- | ------------ | ----------- | ------- |
| `--gold-bg` | `#fbf6ec` | `#241d14` | Page/surface base; feeds `--neu-bg`. |
| `--gold-bg-elevated` | `#f4ecd8` | `#2c2318` | Raised surfaces / overlays. |
| `--gold-text-primary` | `#3b2f1c` | `#f6efde` | Primary ink. |
| `--gold-text-muted` | `#6f5e43` | `#cdbb9c` | Secondary ink. |
| `--gold-text-faint` | `#7d6a4c` | `#b8a17a` | Tertiary ink. |
| `--gold-shadow-dark` | `#c8b794` | `#0f0b07` | Emboss shadow — dark side. |
| `--gold-shadow-light` | `#ffffff` | `#3a3022` | Emboss highlight — light side. |
| `--gold-hairline` | `var(--gold-shadow-dark)` | `var(--gold-shadow-light)` | 1 px edges. |
| `--gold-sunken` | `color-mix(22% shadow-dark, bg)` | `color-mix(30% shadow-light, bg)` | Recessed wells. |

### 3.2 Accents (decoration), inks (meaning) and solids (fills)

| Token | Light Golden | Dark Golden | Role |
| ----- | ------------ | ----------- | ---- |
| `--gold-accent-gold` | `#a8871f` | `#e8c64f` | Decorative gold |
| `--gold-accent-champagne` | `#e8d5a3` | `#f4e3b3` | Decorative champagne |
| `--gold-accent-brass` | `#8a6d3b` | `#c9a227` | Decorative brass |
| `--gold-accent-green` | `#3f9168` | `#6fcf9a` | Positive (graphic) |
| `--gold-accent-amber` | `#a87a1f` | `#f0b836` | Caution (graphic) |
| `--gold-accent-red` | `#c9524a` | `#e85a3a` | Negative (graphic) |
| `--gold-ink-gold` | `#6a4f16` | `#f2d76b` | Gold **text/glyph** |
| `--gold-ink-brass` | `#4a3a0e` | `#e8c64f` | Brass **text/glyph** |
| `--gold-ink-amber` | `#6a4a12` | `#f0b836` | Amber **text/glyph** |
| `--gold-ink-red` | `#8a2a22` | `#e8654a` | Red **text/glyph** |
| `--gold-ink-violet` | `#563a8a` | `#c9b6f0` | Violet **text/glyph** |
| `--gold-solid-ink` | `#fffaf0` | *(inherited)* | Mark/ink on a **dark** solid fill |
| `--gold-on-gold` | `#3b2f1c` | *(inherited)* | Mode-stable ink for the **bright** gold gradient |
| `--gold-solid-gold` | `#8a6d0f` | *(inherited)* | Solid fill (holds white) |
| `--gold-solid-brass` | `#6a4f0c` | *(inherited)* | Solid fill |
| `--gold-solid-amber` | `#8a5a1c` | *(inherited)* | Solid fill |
| `--gold-solid-red` | `#7a2418` | *(inherited)* | Solid fill |

> The **solid fills are mode-stable** — they are deliberately *not* re-defined
> for dark Golden, because they hold white ink/glyphs in both modes (the Neu
> invariant). `--gold-on-gold` is likewise mode-stable: the gold gradient is
> bright in both modes, so its ink must not flip.

### 3.3 Accent plumbing, gradient, focus, radii, motion, shadows

| Token | Light Golden | Dark Golden | Purpose |
| ----- | ------------ | ----------- | ------- |
| `--gold-accent-ink` | `var(--gold-ink-gold)` | `var(--gold-ink-gold)` | Accent text |
| `--gold-accent-ink-strong` | `#4a3810` | `var(--gold-solid-ink)` | Emphasis accent text |
| `--gold-accent-line` | `var(--gold-focus-ring)` | `var(--gold-focus-ring)` | Accent edges/rails |
| `--gold-accent-wash` | `color-mix(12% focus, bg)` | `color-mix(14% focus, bg)` | Accent tint wash |
| `--gold-wash-gold/brass/amber/red` | `color-mix(8% accent, bg)` | `color-mix(10% accent, bg)` | Status washes |
| `--gold-gradient` | `linear-gradient(135deg,#f3e0a4,#ddbb62 48%,#c9a24b)` | *(inherited)* | Signature CTA + success badge |
| `--neu-sheen-gradient` | `linear-gradient(115deg, transparent 20%, rgba(241,217,138,.18) 45%, transparent 65%)` | *(inherited)* | Signature sheen (2 sites only) |
| `--gold-focus-ring` / `-rgb` | `#8a6a14` / `138 106 20` | `#e8c64f` / `232 198 79` | Focus outline + glow |
| `--gold-*-rgb` | `168 135 31` / `201 82 74` / `63 145 104` / `168 122 31` / `59 47 34` | *(re-mapped)* | gold / red / green / amber / scrim triplets |
| radii | `--neu-radius-lg/md/sm` = `28/16/12px` | *(same)* | Matches Neu |
| `--neu-transition` | `150ms ease` | *(same)* | Standard tween |
| `--neu-transition-slow` | `320ms cubic-bezier(.22,1,.36,1)` | *(same)* | Sheen dissolve |
| shadow pair tokens | `--neu-shadow-raised / -inset / -inset-sm / -elevated / -bar / -raised-sm / -card / -focus / -error / -edge` | re-derived (only `--gold-shadow-*` change) | All built from `--gold-shadow-dark/light` |

> Regenerate `--gold-shadow-dark` and `--gold-shadow-light` **together** if
> `--gold-bg` changes — the emboss reads off the pair, exactly as Neu does.

---

## 4. Recipes & the signature sheen

The **signature sheen** appears in exactly **two** places, both non-looping
(opacity-only, never a shadow tween):

1. `.golden .neu-btn-solid::before` — the gold-gradient primary CTA.
2. `.golden .neu-card:hover::after` — the card hover highlight.

**CTA wiring.** `button.tsx` emits `neu-btn-solid` on the `primary` and `pos`
variants (the two "primary action" variants; `pos` is the POS charge/pay CTA). The
CTA uses `background: var(--gold-gradient)` with `color: var(--gold-on-gold)`. In
Neu Light/Dark there is **no** `.neu-btn-solid` rule, so the class is inert.

```
PASS  golden: primary CTA paints the gold gradient (sheen site 1)  "linear-gradient(135deg, rgb(243,224,164) 0%, …)"
PASS  golden: primary CTA ink is the mode-stable --gold-on-gold     "rgb(59, 47, 28)"
PASS  golden: .neu-card::after carries the sheen (site 2)          "linear-gradient(115deg, rgba(0,0,0,0) 20%, …)"
```

The `.golden .neu-status-badge-success` badge shares the gradient and therefore
also uses the dark `--gold-on-gold` glyph; warning/danger keep the white
`--gold-solid-ink` glyph on their dark fills.

**Grain overlay — SHIPPED.** `.golden .golden-grains` is a fixed, 3 %-opacity
SVG `feTurbulence` noise layer that breaks up gradient banding. Scoped to
`html.golden` (invisible in Neu) and mounted once in
[`src/app/(dashboard)/layout.tsx`](../src/app/(dashboard)/layout.tsx) as
`<div aria-hidden className="golden-grains" />`. Disabled under
`prefers-reduced-motion` and `prefers-contrast: more`.

---

## 5. Accessibility branches

| Preference | Behaviour |
| ---------- | --------- |
| `prefers-reduced-motion: reduce` | Global block sets `animation-name: none !important`. Golden's sheen + grain are `display: none`. |
| `prefers-contrast: more` | **Dark Golden only** brightens the text ladder (`--gold-text-primary:#fbf5e8`, `--gold-text-muted:#c4b596`) and hides grain. Light Golden already clears AA, so its ink is left alone (lightening it would put near-white text on cream). |
| No `backdrop-filter` support | `@supports not (…)` raises the dialog-overlay scrim to `0.72` and the lightbox scrim to `0.82`. |

```
PASS  reduced-motion: shimmer / toast slide / status swap disabled  "none"
PASS  prefers-contrast: ladder stays ordered + AA
PASS  golden AA focus ring on --gold-bg >= 3:1 (light 4.7 / dark 10.01)
```

---

## 6. WCAG AA per-pairing report — **all pairs pass**

Ratios are true relative-luminance values, measured by the audit in real Chrome.

### 6.1 Golden Light

| Pairing | Ratio | Min |
| ------- | ----- | --- |
| `--gold-text-primary` on `--gold-bg` | 12.11 | 4.5 |
| `--gold-text-muted` on `--gold-bg` | 5.81 | 4.5 |
| `--gold-text-faint` on `--gold-bg` | 4.83 | 4.5 |
| `--gold-ink-gold` on `--gold-bg` | 7.11 | 4.5 |
| `--gold-ink-red` on `--gold-bg` | 8.01 | 4.5 |
| `--gold-accent-ink` on `--gold-accent-wash` | 6.12 | 4.5 |
| `--gold-ink-gold / brass / amber / red` on their washes | 6.56 / 9.31 / 6.87 / 7.26 | 4.5 |
| `--gold-focus-ring` on `--gold-bg` | 4.70 | 3.0 |
| `--gold-accent-gold / green / amber / red` on `--gold-bg` (graphics) | 3.17 / 3.57 / 3.56 / 4.07 | 3.0 |
| `--gold-on-gold` on gradient stops (light → dark) | 9.95 / 7.06 / 5.44 | 4.5 |

### 6.2 Golden Dark

| Pairing | Ratio | Min |
| ------- | ----- | --- |
| `--gold-text-primary` on `--gold-bg` | 14.53 | 4.5 |
| `--gold-text-muted` on `--gold-bg` | 8.87 | 4.5 |
| `--gold-text-faint` on `--gold-bg` | 6.68 | 4.5 |
| `--gold-ink-gold` on `--gold-bg` | 11.66 | 4.5 |
| `--gold-ink-red` on `--gold-bg` | 5.07 | 4.5 |
| `--gold-focus-ring` on `--gold-bg` | 10.01 | 3.0 |

### 6.3 Mode-stable solids (both modes)

| Pairing | Ratio | Min |
| ------- | ----- | --- |
| `--gold-solid-ink` on `--gold-solid-gold` | 4.72 | 4.5 |
| `--gold-solid-ink` on `--gold-solid-brass` | 7.38 | 4.5 |
| `--gold-solid-ink` on `--gold-solid-amber` | 5.67 | 4.5 |
| `--gold-solid-ink` on `--gold-solid-red` | 9.64 | 4.5 |

### 6.4 Fixes applied (this pass)

| Area | Before | After |
| ---- | ------ | ----- |
| Light `--gold-text-faint` | `#8a7658` (4.05) | `#7d6a4c` (4.83) |
| Light `--gold-accent-gold` graphic | `#c9a227` (2.25) | `#a8871f` (3.17) |
| Light `--gold-accent-amber` graphic | `#d9a441` (2.09) | `#a87a1f` (3.56) |
| Light `--gold-accent-green` graphic | `#4caf7d` (2.52) | `#3f9168` (3.57) |
| Gold CTA ink | white on a wide-range gradient (1.34–4.66) | mode-stable `--gold-on-gold` on a narrowed bright gradient (min 5.44) |
| Light `--gold-solid-gold` | `#9a7b14` (3.87 white) | `#8a6d0f` (4.72 white) |
| Dark solid fills | re-defined bright → white ink 1.60–3.39 | inherits light, mode-stable → 4.72–9.64 |

---

## 7. Structural parity with Neu

| Dimension | Neu | Golden Elite | Parity |
| --------- | --- | ------------ | ------ |
| Scoping hook | `.dark` / default | `.golden` / `.dark.golden` | ✅ |
| Token surface | bg, text×3, shadow pair, hairline, sunken, ink×5, accent×6, solid×4, wash×4, focus, scrim, radii, transitions, 10 shadow tokens | identical names re-pointed via `--gold-*` | ✅ |
| Raw + alias layers both re-pointed | n/a | ✅ both | ✅ |
| Recipes | `.neu-card/-btn/-input/-select/-badge/-toast/…` | same recipes + `.golden` overrides, one copy each | ✅ |
| Radii | 28 / 16 / 12 px | 28 / 16 / 12 px | ✅ |
| Reduced-motion / prefers-contrast / backdrop fallback | ✅ | ✅ | ✅ |
| Leakage into other themes | — | audit-proven none | ✅ |
| Component count | 13 UI components | unchanged | ✅ |

Golden adds **no new components**; it is a pure token + recipe skin.

---

## 8. Fixed alongside the theme (pre-existing defects found while verifying)

1. **Golden did not persist.** `ThemeProvider`'s restore guard only accepted
   `light | dark | system`, so a saved `golden` silently fell back to the system
   theme on every reload. Fixed, and the pre-paint `ThemeInit` script now applies
   `golden` too (no flash on cold load).
2. **Dead `golden:` / `gold-*` utilities.** Several components carried Tailwind
   classes such as `golden:bg-gold-bg` and `text-gold-solid-ink` that never
   compiled (no `@custom-variant golden`, no `--color-gold-*` `@theme` tokens —
   the pre-change build emitted **zero** `golden\:` rules). They were inert dead
   weight that implied a mechanism that did not exist; removed from
   `alert-tile`, `badge`, `dialog`, `empty-state` and `toaster`. The Golden
   colour is still correct there because those components already use the shared
   `bg-neu-*` / `text-neu-*` utilities, which `:root.golden` re-points.
3. **Missing `-rose` tokens.** `alert-tile.tsx` referenced
   `gold-ink-rose` / `gold-solid-rose`; the palette uses `-red`. The dead
   references are gone.
4. **Critical alert tile had no border tint.** Its border class was the dead
   `border-gold-ink-rose/25`. Replaced with `border-neu-ink-red/25` so a critical
   tile is tinted in both themes, matching the warning tier's amber.
5. **`.neu-toast` padding** drifted to `12px 16px` while
   `docs/DESIGN-NEUMORPHISM.md` specifies `14px 18px`; aligned to the spec.
6. **`notification-bell.tsx` used `60vh`**; the house rule is `dvh`-only. → `60dvh`.
7. **Reduced-motion** only shortened animation duration, leaving animations
   named and running; now sets `animation-name: none`.

---

## 9. Verification

```bash
npm run audit:neu     # real PostCSS + Tailwind v4 pipeline + headless Chrome over CDP
npm run typecheck
```

Latest result (includes the Golden block — token re-pointing, scoping, CTA +
card sheen, grain, dark derivation, the full AA table, and the reduced-motion /
prefers-contrast branches):

```
ALL 348 CHECKS PASSED
```

The theme was also verified **live in the running app** (headless Chrome, logged
in as the seeded `super_admin`) on `/dashboard`, `/pos`, `/products` and the
command-palette dialog: `html` carries `golden` + `data-theme="golden"`, the body
surface resolves to `--gold-bg`, the grain sits at `0.03`, enabled primary CTAs
paint the gold gradient with the dark on-gold ink, cards carry the hover sheen,
and the dialog panel uses `--gold-bg` with the `--gold-shadow-dark` edge.
