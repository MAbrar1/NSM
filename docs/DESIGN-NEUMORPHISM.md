# Electric Embossed Neumorphism (neu)

The app's design system. It **replaces** the global theme: the page surface, the
focus ring, every shared `src/components/ui/*` component, the shared page-level
surfaces (data tables, POS, gallery, inventory) and the bespoke per-page markup
are all built from the tokens and recipes in `src/app/globals.css`.

A shadow is a recipe, not a one-off. Every emboss in the product is declared
**exactly once** — as a composed token in `:root` and consumed from
`@layer components`. Component files opt in with a class and must never contain
a raw `box-shadow` string or a one-off hex.

## Scope (Step 0 answers, for the record)

| Question | Answer |
| --- | --- |
| Scope | **Global replace** — surface, focus ring and all shared `ui/*` components |
| Dark mode | **Derived dark tokens** (`--neu-bg` + a re-derived shadow pair under `.dark`) |
| OTP screens | The app had **no** OTP or confirmation screen; per decision we styled the **existing auth pages**, with **register-success as the confirmation screen**. No OTP auth flow was invented, but the OTP input variant is implemented for when one exists. |
| Reference images | Not supplied; the **written spec** is the source of truth (28px card radius, 1px cyan gradient border, 4px inset OTP boxes, 64px green badge). |
| `--neu-text-muted` | Spec value `#64748b` fails AA; adopted the `prefers-contrast` value `#475569` as the default. |

The legacy `--color-*` palette in `@theme` is **still defined**, and after the
phase-3 markup migration three things still legitimately read it: the
`--color-brand-*` accent palette, the bespoke decorative palettes (clock hands,
chart series), and `src/lib/print-brand.ts` — whose sync test parses
`globals.css` and fails if the values drift. New work must use the `--neu-*`
tokens. See "Known gaps" below.

## Tokens

Declared once in `:root`; `.dark` re-derives the surface and **both** shadows
together (never one in isolation). Registered in `@theme` as `--color-neu-*`
purely so components get real utilities (`text-neu-muted`, `bg-neu-bg`,
`text-neu-ink-red`, …).

| Token | Light | Derived dark |
| --- | --- | --- |
| `--neu-bg` | `#e6ecf0` | `#1e293b` |
| `--neu-text-primary` | `#334155` | `#f1f5f9` |
| `--neu-text-muted` | `#475569` | `#94a3b8` |
| `--neu-text-faint` | `#5a6779` | `#8a97a8` |
| `--neu-shadow-dark` | `#babecc` | `#141c28` |
| `--neu-shadow-light` | `#ffffff` | `#283449` |
| `--neu-focus-ring` / `--neu-focus-rgb` | `#0891b2` / `8 145 178` | `#22d3ee` / `34 211 238` |
| `--neu-ink-cyan` | `#155e75` | `#22d3ee` |
| `--neu-ink-green` | `#166534` | `#4ade80` |
| `--neu-ink-amber` | `#92400e` | `#fbbf24` |
| `--neu-ink-red` | `#b91c1c` | `#f87171` |
| `--neu-accent-ink` | `#155e75` | `#22d3ee` |
| `--neu-accent-ink-strong` | `#164e63` | `#67e8f9` |
| `--neu-accent-line` | `var(--neu-focus-ring)` → `#0891b2` | `var(--neu-focus-ring)` → `#22d3ee` |
| `--neu-accent-wash` | 12% ring tint of `--neu-bg` | 14% ring tint of `--neu-bg` |
| `--neu-wash-cyan / green / amber / red` | 8% of the vivid accent mixed into `--neu-bg` | — (re-derives from the dark surface; no `.dark` override) |
| `--neu-accent-solid` / `-solid-strong` | `#0e7490` / `#155e75` | — (mode-stable) |
| `--neu-solid-ink` | `#ffffff` | — (mode-stable) |
| `--neu-solid-cyan / green / amber / red` | `#0e7490 / #15803d / #b45309 / #b91c1c` | — (mode-stable) |
| `--neu-hairline` | `var(--neu-shadow-dark)` | `var(--neu-shadow-light)` |
| `--neu-sunken` | 22% dark tint of `--neu-bg` | 30% light tint of `--neu-bg` |
| `--neu-scrim` | `rgb(51 65 85)` | — (mode-stable) |
| `--neu-radius-lg / md / sm / full` | `28px / 16px / 12px / 9999px` | — |
| `--neu-transition` | `150ms ease` (`0ms` under reduced motion) | — |

### Accents are decoration; ink carries meaning

The spec's "electric" hues are deliberately saturated and therefore **not
legible as ink**. They survive as `--neu-accent-*` for decoration only (card
glow, accent lines, colour washes, the glow behind a ring, filled badges,
`::selection`):

| Accent (decoration) | Light | Meets 3:1 on `--neu-bg`? |
| --- | --- | --- |
| `--neu-accent-cyan` | `#00f2fe` | **1.16:1 — no** |
| `--neu-accent-green` | `#22c55e` | **1.91:1 — no** |
| `--neu-accent-amber` | `#f59e0b` | **1.80:1 — no** |
| `--neu-accent-red` | `#ef4444` | **3.16:1 — yes (barely)** |

Anything whose colour *means* something uses the same-hue `--neu-ink-*` instead:
text, glyphs, indicators, delta chips, status headings, focus rings. In dark
mode the ink set flips to lighter shades and is re-verified there too.

### Solid fills vs ink — two different jobs

`--neu-ink-*` **flips** with the theme, because legible *text* needs a dark ink
on a light surface and vice versa. A solid fill that carries a **white** mark
(the 64px status badge, `.neu-badge-solid`) needs the opposite: dark enough in
*both* modes. So those use a separate, deliberately **mode-stable**
`--neu-solid-*` set anchored to the same hue. White on the spec's vivid accents
measured only **2.15–2.28:1**, under the 3:1 non-text minimum; white on the
solid set measures **5.01–6.47:1**.

Likewise `--neu-scrim` (an overlay that sits on *imagery*, e.g. the POS "out of
stock" veil) must stay dark in both modes — it is not a surface tint.

Accent *channel triplets* (`--neu-cyan-rgb`, `--neu-red-rgb`, `--neu-green-rgb`,
`--neu-amber-rgb`, `--neu-scrim-rgb`, `--neu-focus-rgb`) let recipes compose
`rgb(… / a)` without restating a hex, so each colour stays single-sourced.

`@media (prefers-contrast: more)` darkens the inks further
(`#1e293b` / `#334155`) **and `--neu-text-faint`** (`#475569`) — without that
last one the ink ladder would *invert*, because `muted` would jump to 8.69:1
while `faint` stayed at 4.83:1. The audit asserts the ladder stays *ordered and
AA* under that preference, not just the individual tokens.

### The interactive accent

`--neu-accent-*` is where the legacy blue `--color-brand-*` palette went. One
cyan could not do the job, so it is split by *role*, exactly like ink vs solid:

| Token | Job | Why it is its own value |
| --- | --- | --- |
| `--neu-accent-ink` / `-strong` | accent **text** and glyphs | must clear AA **on the page surface and on the wash** |
| `--neu-accent-line` | **borders, rings, tint/heat fills** | must clear SC 1.4.11 (3:1), so it *is* `--neu-focus-ring` — one proven cyan for every edge, re-measured per use instead of per token |
| `--neu-accent-wash` | a tinted **panel** behind accent content | derived from the ring + surface via `color-mix`, so it re-derives under `.dark` with no second hex |
| `--neu-accent-solid` / `-strong` | **solid fills** carrying `--neu-solid-ink` | mode-stable, like the rest of the `--neu-solid-*` family |

### Composed shadow tokens

Recipe *geometry* is also a token, so a page-level surface reuses an emboss with
`var(--neu-shadow-inset)` instead of re-typing offsets — and the shadow pair
stays the only colour source. These are declared on `:root`, which is the same
element `ThemeProvider` puts `.dark` on, so they re-derive under `.dark`
(guarded by the `dark: … re-derives` audit checks).

| Token | Value (offsets only; pair substituted) |
| --- | --- |
| `--neu-shadow-raised` | `6px 6px 14px` dark + `-6px -6px 14px` light |
| `--neu-shadow-inset` | both sides `inset 4px 4px 8px` |
| `--neu-shadow-inset-sm` | both sides `inset 2px 2px 4px` |
| `--neu-shadow-elevated` | `10px 10px 20px` pair |
| `--neu-shadow-bar` | `0 10px 18px -12px` dark only — the bar's scrolled state, a lid rather than a card |
| `--neu-shadow-raised-sm` | `3px 3px 7px` pair |
| `--neu-shadow-card` | `14px 14px 28px` pair **plus** `0 0 15px rgb(cyan / .15)` |
| `--neu-shadow-focus` | `inset 2px 2px 4px` dark + `0 0 12px rgb(focus / .5)` |
| `--neu-shadow-error` | `inset 2px 2px 4px` dark + `0 0 12px rgb(red / .4)` |
| `--neu-shadow-edge` | `inset 0 -1px 0` dark — the sticky-table-header hairline |

No `box-shadow` declaration anywhere hard-codes its offsets or a colour; the
audit enforces both.

## Recipes

The only place a shadow is *used*.

| Class | Recipe |
| --- | --- |
| `.neu-raised` | `var(--neu-shadow-raised)` |
| `.neu-raised-sm` | `var(--neu-shadow-raised-sm)` (chips, keycaps, the rail's collapse chip) |
| `.neu-inset` | `var(--neu-shadow-inset)` |
| `.neu-inset-sm` | `var(--neu-shadow-inset-sm)` (pills — 4px reads muddy at pill scale) |
| `.neu-elevated` | `var(--neu-shadow-elevated)` (toasts float higher than a card) |
| `.neu-disabled` | `var(--neu-shadow-raised-sm)` + muted ink + `not-allowed` + 0.7 |
| `.neu-card` | `var(--neu-shadow-card)`, radius-lg, `36px 28px` padding, and a `::before` that paints the 1px cyan gradient top-border via a mask |
| `.neu-card-flush` | padding `0` — for containers that own their inner padding |

Component classes: `.neu-btn` / `-sm` / `-icon` / `-icon-sm` / `-icon-lg` /
`-block` / `-plain` / `-danger`, `.neu-input` / `-otp`, `.neu-select`,
`.neu-label`, `.neu-separator-h` / `-v`, `.neu-badge` + colour variants +
`-solid`, `.neu-skeleton` (alias `.skeleton`), `.neu-chart-grid` / `-axis` /
`-value` / `-baseline`, `.neu-image-frame`, `.neu-dialog-overlay` / `-panel` /
`-title` / `-text`, `.neu-toast` + icon tones, `.neu-empty-icon` / `-title` /
`-body`, `.neu-stat-value` / `-label`, `.neu-delta-up` / `-down`,
`.neu-status-badge` / `-success` / `-warning` / `-danger` + `.neu-status-heading`
/ `-body`, `.is-success` / `.is-status-in`, `.neu-focus`.

Recipes live in `@layer components` so Tailwind utilities (`w-full`, `mt-4`)
still win at the call site.

## Component specs

* **Input** — 48px, 16px/500, start-aligned, 16px padding, inset recess, no
  default border/appearance. Focus `2px` **AA cyan** + `var(--neu-shadow-focus)`.
  Error `2px` `--neu-accent-red` border (a 3.16:1 ring — passes the 3:1 non-text
  minimum) + `var(--neu-shadow-error)`. Disabled `.neu-disabled`. OTP variant
  `56×64`, 24px/700 centred.
* **Button** — 52px, no border, radius-md, 16px/600, primary ink, `.neu-raised`;
  pressed swaps to the inset shadows; disabled `.neu-disabled`; `--sm` 36px/13px;
  `--icon` 44px with a 20px muted glyph; danger hovers to **red ink** (5.43:1).
* **Badge** — 24px, `0 10px` padding, 12px radius, 12px/600, `.neu-inset-sm`.
  Colour variants are **ink** (`text-neu-ink-*`), so the 12px labels clear AA.
  `.neu-badge-solid` is the filled escape hatch: accent fill + near-black same-hue
  ink (4.97–11.90:1).
* **Separator** — two 1px lines (dark over light), never `.neu-inset`.
* **Skeleton / table-skeleton** — inset + a 1.6s white sweep; table rows are
  40px with an 8px gap.
* **Chart** — grid/axis ink from tokens, bars flat semantic fills, no shadow on
  the data.
* **Dialog** — scrim `rgb(scrim / .35)` + `blur(2px)`, panel `.neu-card` capped
  at 480px, entrance opacity + `scale(.96→1)` in 150ms.
* **Toaster** — `.neu-elevated`, radius-md, `14px 18px`, row + 10px gap, **ink**
  icon tones, entrance opacity + `translateY(8px→0)`.
* **Empty state** — `.neu-card`, 64px inset icon circle, 16px muted title,
  14px muted body (red **ink** icon in the error state).
* **Stat card** — `.neu-card`, 24px padding, 30px/700 value, 13px muted label,
  green/red **ink** delta.
* **Status swap** — `.is-success` class toggle on a **sibling** element; fade +
  `translateY(8px→0)`, never a shadow tween. Badge is a solid 64px accent circle
  with a `0 8px 20px rgba(accent,.35)` glow, a white 28px **SVG** mark, and the
  heading in the matching **ink**.

## Page surfaces (phase 2)

The shared page-level CSS surfaces were migrated onto the neu tokens — the same
recipe vocabulary, no per-surface embedding, and **no dark override needed**
anywhere (the tokens carry both modes).

| Surface | Before | After |
| --- | --- | --- |
| `::-webkit-scrollbar-thumb` | `--color-surface-300` / `-400` | tint of `--neu-shadow-dark`; hover = muted ink; radius-full |
| `.inv-route-node` | `surface-100` pill + a `.dark` colour pair | recessed chip (`--neu-shadow-inset-sm`, primary ink) |
| `.inventory-empty*` | `surface-100/400/700` + four `.dark` rules | recessed icon chip + primary/muted ink |
| `.inventory-transfer-card` | `radius-xl` + hairline border + `shadow-sm` | `--neu-radius-md` + raised emboss, lift on hover |
| `.smart-image` (checkerboard + icon) | `surface-100/200/400` | tint of `--neu-shadow-dark` over `--neu-bg`; muted-ink icon |
| `.pos-segmented`, `.pos-pay-tile`, `.pos-chip`, `.pos-icon-btn`, `.pos-stock-badge`, `.pos-cash-quick-btn` | white fills + borders | raised/inset recipes, ink for the stock badge |
| `.product-card`, `.product-thumb`, `.bulk-bar`, `.product-price-unit` | white + borders + `shadow-sm` | card/raised recipes, recessed bulk tray |
| `.gallery-item`, `.gallery-control-btn`, `.gallery-drag-hint` | white overlays | neu radius scale + tokens (drag hint stays an overlay-on-image exception) |
| `.inventory-table`, `.products-table` (sticky thead, zebra, `.qty-bar`, `.inv-th`) | `surface-*` borders/fills | `--neu-shadow-edge` hairline, shadow-tinted zebra, ink qty fills |
| `.filter-chip`, `.chip-btn`, `.inventory-tabs`, `.inventory-stat-icon`, `.pagination-*` | tinted fills + borders | raised-at-rest / recessed-when-active; one recessed chip per stat tone |
| `.barcode-label-card` | — | **paper exception** (see below) |
| `.lightbox-close` / `-arrow` / `-counter` | — | **chrome exception** (see below) |

## Page markup (phases 3–4)

> Phase 5 did not change the mapping. It added the guarantees the mapping could
> not give on its own: probes for `:active`, `:disabled` and the relational
> variants, geometry measurement on real overlays, and source ratchets for the
> dead-class and doubled-translate failure modes (see **Verification**, and
> deviations 9–10). It also closed the last two bypasses of the token layer —
> the retired brand blue baked into an arbitrary shadow value, and the silent
> no-op of a relational variant with no marker to key off.
>
> **Phase 6** then migrated the *semantic* half of the same vocabulary — the
> status colours that were never `brand-*` to begin with. `bg-success-500/15`,
> `text-danger-500`, `border-warning-500/30` and their `dark:` twins became
> `bg-neu-wash-*` / `text-neu-ink-*`, suffix-aware again, so a 12% tint does not
> turn into a solid fill and a solid fill does not turn into a tint. It moved
> **237 class strings**, and it covered the **chart/series configs** too, which
> had been reading `var(--color-<hue>-500)` straight out of the legacy palette —
> an unseen bypass of the whole token layer, and a 2.26:1 one on the dark
> surface. Two gradient stops the codemod could not map safely (`via-*`) were
> hand-fixed. The legacy palette itself stays defined for `print-brand.ts`.
>
> **Phase 7** added no colour: it is the modal keyboard contract described under
> **Verification**, and the static test that stops a future overlay from claiming
> modality without it.
>
> **Phase 8** finished the shell — the bar, the rail and the clock are now the
> same system as the pages (see **Shell chrome**). It also removed the last
> glyph "icons" in the app: a 12-emoji entity map in the audit log, a `★`
> rating, a `⚠` error state, a `✅` empty state and a `👋` greeting, which are
> all inline `<svg>` now — and the audit refuses to let an emoji or an
> icon-font class name back in.

The shared page *classes* were neu after phase 2, but the bespoke JSX still
composed legacy utilities (`bg-white`, `text-surface-400`, `border-surface-200`,
`dark:bg-surface-100`) and the pre-neu focus cluster
(`focus:ring-2 focus:ring-brand-500/20`).

`scripts/codemod-neu-markup.mjs` migrated them in two passes and is kept in the
repo so the transformation is reviewable and re-runnable (it backs every
pre-image up to `.codemod-backup/neu-markup/` and re-parses each file with the
TypeScript compiler, leaving it byte-identical if the result would not parse):

| Legacy | neu |
| --- | --- |
| `bg-white` | `bg-neu-bg` |
| `bg-surface-50/100/200/300` | `bg-neu-sunken` (a mode-aware recessed wash) |
| `text-surface-300/400/500` | `text-neu-faint` (the third, dimmest ink) |
| `text-surface-600` | `text-neu-muted` |
| `text-surface-700…950` | `text-neu-primary` |
| `border-`/`divide-`/`ring-surface-*` | `*-neu-hairline` |
| `dark:<axis>-surface-*` | dropped when that axis now has a mode-aware token, else converted |
| `focus:ring-*`, `focus:border-brand-*`, `focus:outline-none`, … | the single `neu-focus` class |
| `hover:X` where the element already carries bare `X` | dropped — it could never paint |

**Scope: colour and focus only — geometry is untouched.** Heights, padding,
radii and grids are exactly as they were, because forcing dense in-page controls
into the 48px `.neu-input` / embossed shapes would have been a redesign, not a
token migration. A `focus:opacity-100` reveal is deliberately *not* treated as a
focus indicator.

### The accent palette (phase 4)

The legacy blue accents are gone from the screen. The rule is **suffix-aware**,
because the same `bg-brand-N` means two different things — an opaque fill that
carries white ink, or a tint/heat step that must follow the surface:

| Legacy | neu | Why |
| --- | --- | --- |
| `text-brand-400/500/600` | `text-neu-accent-ink` | accent text |
| `text-brand-700/800` | `text-neu-accent-ink-strong` | its hover / emphasis step |
| `bg-brand-50/100` (any opacity) | `bg-neu-accent-wash` | a pale accent panel |
| `bg-brand-400/500/600/700` **opaque** | `bg-neu-accent-solid` / `-solid-strong` | a solid fill holding white ink |
| `bg-brand-400/500/600/700` **with `/opacity`** | `bg-neu-accent-line/opacity` | a tint or heat step — mode-aware, so its `dark:` twin is dropped |
| `border-`/`divide-`/`ring-`/`from-`/`via-`/`to-brand-*` | `*-neu-accent-line` | every edge and gradient stop needs 3:1 |
| `shadow-brand-*` | `shadow-neu-accent-line` | a coloured glow |
| `accent-brand-*` | `accent-neu-accent-solid` | a native checkbox fill |
| `dark:`-prefixed twins of the above | dropped | the neu token already flips, **except** the mode-stable solids |

That pass moved **183 class strings across 25 files**; the runtime
`var(--color-brand-500)` references in the charts, the ring gradients and the
live-clock were then hand-pointed at `var(--neu-accent-line)`, and the one
directional leftover (`border-t-brand-600`, a spinner needing a *different*
colour from its track) at `border-t-neu-accent-solid`. The codemod now *reports*
any brand token it cannot map, so nothing can survive silently.

Four things are intentionally left alone:

* **Print and export surfaces** (`barcode-label.tsx`, `print-preview.tsx`,
  `src/lib/print-*.ts`, `src/lib/csv.ts`) — white paper and spreadsheet cells, not
  neu surfaces. They are the separate "paper" vocabulary.
* **`src/lib/print-brand.ts`** — the print palette *mirrors* the legacy `@theme`
  tokens on purpose, and `tests/print-brand-sync.test.ts` parses `globals.css`
  and fails if the two ever drift. This is why the legacy palette stays defined
  even though nothing on screen references it.
* **The bespoke decorative palettes** — the live-clock hands, the second chart
  series (`#8b5cf6`) and the status hues keep their own vocabularies.
* **`bg-surface-800/900` and the `from-/to-/via-surface-*` gradient stops** — the
  only surface tokens with no safe mechanical mapping; they are reported by the
  codemod and were hand-fixed (to `bg-neu-scrim` / a flat `bg-neu-sunken`).

### Direction: logical utilities (phase 9)

The app ships Urdu, and `I18nProvider` flips `document.documentElement.dir` to
`rtl`. A physical utility then stops meaning what it says, so the whole UI now
uses Tailwind's logical equivalents — `ms-*`/`me-*`, `ps-*`/`pe-*`,
`start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`,
`rounded-s`/`-e`/`-ss`/`-se`/`-es`/`-ee`, `float-start`/`-end`.

`scripts/codemod-neu-logical.mjs` (same contract as the markup codemod: dry run
by default, `--write` to apply, pre-images in `.codemod-backup/neu-logical/`,
TypeScript re-parse before any file is written) migrated **189 class strings
across 26 files** (39 in the shell and the shared `ui/*` components, the rest in
page markup). Every rule anchors the utility's *value* rather than a bare
prefix, which is what keeps three near-misses out of the map: the prose
`left-handed` is not a spacing value, `rounded-lg` is a radius SIZE (rewriting it
to `rounded-sg` would delete the radius) and `border-radius:` is CSS inside a
print template.

The boundary is drawn by what the thing *is*, and only three categories exist:

| Category | Rule | Examples |
| --- | --- | --- |
| **Layout anchor** | logical | margins, padding, insets, text alignment, edge borders, corner radii |
| **Light** | physical, never mirrored | the emboss pair, the vertical separator's two-line edge, the bar's lift |
| **Direction-neutral** | physical, because both directions agree | `left: 50%` + `translateX(-50%)` centering (the dialog, the lightbox counter) |

Two consequences are worth naming. `dir="ltr"` islands (the clock, the two
receipt facsimiles) use logical utilities *inside* the island — the island
supplies the direction, so `text-start` there means the paper's left. And
`translate-x-*` is untouched by the migration: a transform is a physical
gesture, so the drawer, the switches and the hover arrow keep explicit
`rtl:` pairs, and the codemod reports any span that carries one instead of
half-converting it.

The 189 figure is the second pass. The first one covered 156 spans and *looked*
complete while silently skipping every margin/padding utility in the repo: the
detector's spacing alternative matched the bare prefix `ml-` and its own
end-of-token guard then rejected the digit that followed. The value anchors above
are what fixed it, and both the codemod and `audit:neu` now share them so the
blind spot cannot come back — the ratchet would have reported a clean sweep while
`ml-2` sat in a component.

## Shell chrome (phase 8)

The bar, the rail and the clock are the only surfaces on **every** page, and
until this phase they were the last place the system stopped: the rail told a
screen reader nothing about the current page, two of the three `<nav>`
landmarks had no name, the bar's icon-only controls leaned on `title` alone
(a tooltip, not a name) while the shortcuts modal's `✕` had no name in any
form, and the clock was still a bespoke bezel with its own private palette.

**The bar.** Two anchors instead of three floated groups: a left cluster
(nav toggle → *where am I* → the search well) and a right cluster pushed by its
own `margin-inline-start`, so the well grows into whatever width is left
instead of `justify-between` redistributing everything whenever a control
appears.

* *Where am I* is a section + page label resolved from the **same** `NAVIGATION`
  map the rail is drawn from, so the two cannot disagree about what a route is
  called. Exact hits win over prefix hits (`/settings/audit-log` is not reported
  as `/settings`), a detail route such as `/orders/<id>` inherits its parent's
  name rather than printing a raw id, and anything else falls back to a
  humanized path segment.
* The search well is a recessed well with a raised `⌘K` keycap, and below `lg`
  it becomes an **icon-only trigger** — the palette previously had no touch
  entry point at all, i.e. the feature existed and was unreachable on a phone
  or a tablet without a physical keyboard. A trigger that is hidden *above* a
  breakpoint is invisible to every probe that runs at desktop width, so it is
  measured separately at `375×667`.

**The bar has a degradation ladder, and finding it required measuring.** The
right-hand cluster is 679px wide with every control in it, and the widest band
is the tightest: at 768–1023 a 260px rail leaves the bar 508px and the cluster
overflows by **456px** — clipped by the layout's `overflow`, so the tail of the
cluster was simply **invisible on a tablet**. It was pre-existing and no
existing check could see it: the overlay probes do measure page overflow at
375/768, but only *while an overlay is open*. The shell is therefore measured
at 375, 768, 1024 and 1440 with nothing open, and two changes make it fit at
every one of them:

* **the rail is icon-only below `lg`** (see below) — that is the 188px that
  keeps every control visible in the tight band, and it removes the need to
  hide anything;
* **the clock swaps form rather than shrinking**: dial + full readout at `xl`+,
  compact `HH:MM AM/PM` below it, and nothing at all below `sm`. A dial with no
  readout tells you nothing at a glance; a full readout does not fit a tablet
  bar. Its `aria-label` states the full time at *every* width, so the swap is
  invisible to assistive tech.

| Width | Rail | Palette | Clock | Page context |
| --- | --- | --- | --- | --- |
| < 640 | — | icon | — | — |
| 640–767 | — | icon | compact | — |
| 768–1023 | 72px | icon | compact | — |
| 1024–1279 | 72 / 260 | well | compact | — |
| ≥ 1280 | 72 / 260 | well | dial + readout | ✓ |

The palette opener is never the control that gets dropped: the wide well
becomes a 34px icon button below `lg`, so the feature stays reachable on touch
at every width.

**The rail.** Its width is the one piece of the shell that is *real estate the
content needs*, so it has its own ladder — 72px at every width below `lg`
whatever the preference says, and only from `lg` does the user's choice decide
between 72 and 260:

* **Collapsing it gives the space back.** The content column carries
  `max-w-7xl` while the rail is open and `max-w-[1600px]` when it is closed, so
  the freed 188px widens the measure instead of becoming margin. Measured on
  `/products` at 1440: `main` 1180 → 1368, the content column 1174 → 1362, and
  the products table **1104 → 1292** — the table absorbs the room, which is the
  whole point of collapsing a rail.
* **A skip link** is the first thing in the tab order: `#main-content` on a
  `<main tabIndex={-1}>`, so it moves *focus* and not just the hash. A shell
  with a rail and a bar costs a keyboard user 28 Tab stops before the content
  otherwise — measured, not estimated.
* **The rail's first control is "New Sale"** (role-gated), because the one
  action a POS shell should never make you hunt for is the thing a cashier does
  all day. It is the **one filled control** in the shell (`--neu-solid-ink` on
  `--neu-accent-solid`), which is the pair the audit already proves at ≥ 4.5:1
  in both modes; below `lg`, and collapsed, its text goes and it becomes a 48px
  icon row like every other one.
* The footer names the build (`ElitePOS v0.1.0`) — the one line support asks
  for, in the chrome rather than behind a menu.
* **The rail's children stay full-width and centre their own contents.**
  Centring them as flex *items* instead shrinks each wrapper to its content —
  which turned the "New Sale" control into a 16px textless sliver the moment it
  lost its label. The audit caught it at 48px expected vs 16px measured.
* Nav rows are one definition for six lists (three groups × rail and drawer):
  flat at rest, recessed tint on hover, and the current page wears the accent
  wash + inset emboss + an accent edge bar — plus `aria-current="page"`, which
  is the only thing that tells a screen reader where it is. Before this the rail
  communicated the current page with colour alone.
* Both `<nav>` landmarks are named (`Primary navigation` / `Main menu`). Two
  unnamed navs are indistinguishable in a landmark list, and the landmark list
  is how a screen-reader user navigates a shell at all.
* The rail gained a **signed-in identity block** above its collapse chip: name
  plus the same role chip the account menu uses, in a recessed socket. The role
  is the thing you are told to check when a control you expect is missing, and
  it was previously reachable only by opening the avatar menu. Collapsed, the
  block degrades to the avatar with the name as its `title`.
* The collapse toggle now names the action it will perform (`Expand sidebar` /
  `Collapse`). Collapsed, its visible label is gone — so the control had no
  accessible name in exactly the state where it is the only way back.

**The bar lifts when there is content under it.** At rest the bar is flush with
the page and separates itself with the `--neu-separator-h` emboss; the moment
`main` scrolls, it takes `--neu-shadow-bar` — a **downward-only** shadow, because
a bar is a lid and not a floating card, and the asymmetric pair says exactly
that. No listener beyond `onScroll` on the scrolling element, and the state is
a boolean so the shadow flips once per crossing rather than per frame.

**The same shell in Urdu.** `dir` becomes `rtl`, which turns every physical
direction utility in the chrome into a latent bug. Three were real:

| Was | Now | In RTL it had |
| --- | --- | --- |
| rail and drawer `left-0` | `start-0` | the trailing-edge panel on the leading edge |
| drawer `-translate-x-full` closed | `+ rtl:translate-x-full` | **the CLOSED drawer over the content** — a full-height overlay nobody opened |
| toasts + sync pill `right-4` | `end-4` | both stacks over the rail |

The runtime half is measured through the **real language toggle**, not by
writing `dir` by hand: at 1440 the rail measures `1180–1440` (its width exactly
the viewport's tail) with `main` ending where the rail begins, the bar's nav
toggle sits to the *right* of the action cluster, and there is no horizontal
overflow. At 375 the closed drawer measures `left: 375` — off the trailing edge
— and the open one `95 → 375`, i.e. it arrives from the right. The clock is
asserted to stay an **LTR island** (a clock is not text) and the emboss is
asserted **not** to mirror: a light source is a property of the room, not of the
reading direction.

**Density is uniformity, not smallness.** The densest views in the app are
tables, and two of them were ragged — the row height was encoding data:
`/products` varied **64–77px** because the brand line under the name was
conditional, and `/orders` varied **61–73px** because the payment badge stacked
under the status badge only when there was a balance. Both now reserve the
second line (a 14px leading placeholder, `\u00A0`) or put the two badges in a
row, so every row matches its siblings: `/products` 64–69, `/orders` 61–65,
`/customers` 61, `/refunds` 61, `/suppliers` 61, `/settings/audit-log` 61 — and
`/inventory`, the densest list in the app at 70 rows, went **75 → 67px** per row
by taking `.inv-td` / `.inv-th` to 8px of block padding. All eight table pages
are measured, because raggedness is content-driven: it appears on whichever page
happens to have the optional second line.

**The clock** is a neu instrument: a recessed dial well inside a raised bezel,
a digital readout in its own inset window, an accent seconds sweep and an
accent-cored hub. It reads nothing but neu tokens now — the `info → purple`
gradient bezel, the rose `#f43f5e` second hand and the `#a855f7` hub are gone,
which is why the theme audit's clock exemption could be deleted rather than
kept. The readout is a `<time dateTime>` that states its value once as a single
`aria-label` ("Wednesday, September 25, 2026, 9:41:07 PM") with the digits
hidden from assistive tech, because otherwise a screen reader announces the
fragmented "09 : 41 : 07 PM" *after* the sentence that already said it.

## Verification

```
npm run audit:neu          # 309 checks, no server — also runs in CI
npm run audit:neu:pages    # 381 checks against the real, rendered pages
```

**`audit:neu` — the design system.** Compiles `globals.css` through the project's
real PostCSS + Tailwind v4 pipeline, injects the result into real Chrome over
CDP, and reads **computed** styles from a fixture mirroring the real component
markup. Needs no Next server, so it runs even while a dev server holds `.next`.

**309 checks** cover: the tokens; the accent/ink/solid split; the interactive
accent set; the same-hue washes (each one is referenced, tinted rather than
equal to the surface, re-derives under `.dark` with no override, and its own ink
clears AA **on it** in both modes — with a control pair proving the *vivid*
accent would fail the same test); WCAG contrast **computed in-engine** for every
ink, all three ink ladder steps, the accent ink **on its own wash**, the focus
ring and the solid badge glyphs, in **both** modes; the composed shadow tokens and their dark
re-derivation; every component spec; keyboard focus; the phase-2 page surfaces;
the phase-3/4 markup ratchet and its phase-5 additions; the documented
exceptions; reduced motion; `prefers-contrast`; the icon vocabulary (no emoji,
no icon-font class names, and no vivid accent used as *text*); **direction**
(no physical direction utility anywhere in `src/**/*.tsx`, no physical layout
property in `globals.css`, and no LTR island other than the three that state
their reason); and the shell chrome's own contract — named nav landmarks,
`aria-current` on the rail, a rail toggle that names its action in **both**
states, an accessible name on every icon-only control, and a palette entry
point that exists at phone width.

Three classes of claim that computed styles alone cannot expose are asserted
statically:

* **declarations** — the scrollbar thumb, "no `box-shadow` hard-codes its
  geometry / a colour", and the ratchet counts below;
* **that every neu utility the markup references actually compiles.** Tailwind
  emits *nothing* for an unknown class and reports no error, so one typo
  anywhere in the migrated JSX would otherwise ship a silently dead class. This
  one check is what makes a 1,200-string migration safe;
* **that a utility's selector can ever match.** A `group-*` / `peer-*` variant
  only paints if the marker class it keys off exists, and a keyframe's
  `transform: translate()` *composes* with Tailwind v4's `translate` property
  instead of overriding it. Both failure modes compile, paint nothing useful,
  and are invisible to every value-based check — so both get their own guard
  (see the ratchet table).

**`audit:neu:pages` — the migrated markup, in every state.** Logs in over CDP,
renders `/dashboard`, `/orders`, `/inventory`, `/products`, `/customers`,
`/pos`, `/reports/sales`, `/reports/inventory`, `/purchase-orders` and
`/settings` — the reporting and settings surfaces carry the densest
toolbar/menu state in the app — and scans **every** rendered element (~12,400
across the ten) asserting
that no `color`, `background-color` or `border-color` resolves to a legacy
light-mode palette value, that the page surface is `--neu-bg`, and that the new
utilities resolve rather than no-op. It needs a built app and a seeded DB:

```
npm run build && npx next start -p 3311     # shell 1
npm run audit:neu:pages                     # shell 2
```

The shared chrome is measured on its own ladders: the header is checked at
375, 768, 1024 and 1440 with **nothing open** (the overlay probes only ever see
a page with an overlay in front of it), the rail is measured at 768 and 1440
to prove it is 72px with hidden labels in one and 260px with all 16 visible in
the other, collapsing it is measured as a *change in the content width* (and
the table's) rather than as a class, the clock is read in both of its forms,
and the palette's below-`lg` opener is driven at 375 — because a control that
is hidden above a breakpoint is invisible to every probe that runs at desktop
width.

**A keyboard-only pass** walks the shell with real `Tab` presses at 1440: the
first stop must be the skip link and `Enter` on it must land focus on
`<main id="main-content">` (not merely move the hash), then the walk proceeds
until it reaches `main`, asserting that it takes at least 10 stops (i.e. the
walk is real, currently 28), that **every** stop has something to announce, and
that nothing in the *closed* mobile drawer (`inert`) is ever reachable.

It also probes the states a resting scan cannot reach. A surviving
`hover:bg-surface-50` or `focus:ring-brand-500/20` compiles perfectly and simply
never paints because the audit never *enters* the state — so the audit drives
`CSS.forcePseudoState` over CDP to run the real cascade with no pointer or
keyboard, killing transitions first so the first read is already the final
value. `:disabled` is not a forceable pseudo-class, so for that one the element
property is toggled instead — which makes the pseudo-class match for real.

| State | How it is entered |
| --- | --- |
| `:hover` | forced on the element carrying the bare `hover:` utility |
| `:focus-visible` | forced on every `.neu-focus` |
| `:active` | forced on the element carrying the bare `active:` utility |
| `:disabled` | `el.disabled` toggled, then restored (explicit `disabled:` utilities **and** every class `globals.css` styles for `:disabled`, read from the stylesheet) |
| `group-*` / `peer-*` | forced on the **ancestor** (`.group`) / the **preceding sibling** (`.peer`) the variant keys off, then the *target* is read |

Per page it asserts: no state adds a legacy colour; **every** affordance
actually changes something (a dead `hover:X` beside a bare `X` is a bug, not a
no-op); focused `.neu-focus` paints `--neu-focus-ring`; a disabled control is
never invisible (ink equal to its own fill); and every `group-*`/`peer-*`
utility has its marker class somewhere in the DOM. Caps: 45 hover / 35 focus /
25 press / 25 disabled / 45 relational per page, each reported as
`probed/total`.

### Modal and overlay geometry

The same harness opens real overlays and measures them, because "fits the
viewport" is a claim a static reading cannot make. Only **additive** triggers
are clicked (never delete / pay / save) and nothing inside an open overlay is
ever clicked, so it cannot mutate data: open, measure at `1440×900`,
`768×1024` and `375×667`, `Escape`, repeat. Ten overlays are covered this way —
the page dialogs (`View Details`, `New Transfer`, `Add Product`, `Print
Barcode`, `Add Customer`, edit forms, the POS detail and quantity panels) plus
the shared chrome (the command palette and the shortcuts modal) — and the two
sheets a generic trigger hunt can never reach (the mobile nav drawer, the POS
cart sheet) are measured on visits of their own.

Four traps this probe had to be taught, each of which had made it lie:

1. **An anchor with an `href` navigates.** The dashboard's quick-action cards
   are anchors; clicking one drove the probe to `/pos`, whose keypad made the
   numbers look plausible while the dashboard's own overlay was never measured.
2. **A layout-level dialog is always mounted-open first.** The one-time
   onboarding modal opened over every page and, being first in DOM order, was
   the panel `querySelector` returned — plausible at 480×516 and wrong. The
   audit now dismisses onboarding up front *and* identifies the panel by "not
   present before the click".
3. **`role="dialog"` is often a full-bleed wrapper.** An `inset-0` box always
   "fits" the viewport, so measuring it can never fail. The probe descends to
   the visible card (skipping the scrim) before measuring.
4. **Icon-only triggers have no text.** The palette and shortcuts buttons carry
   their whole accessible name in `title`/`aria-label` and have no text content,
   so a `textContent`-only lookup skipped them and two of the app's four
   `role="dialog"` overlays were never measured at all.

### The modal keyboard contract

Geometry cannot tell a usable overlay from a keyboard trap with no way out, or
from a panel that announces modality and then hands focus to `<body>`. So while
an overlay is still open the probe reads its **contract**: is focus inside the
panel, does one `Tab` stay inside *and actually move*, and does `Escape` hand
focus back to the element that opened it.

"Actually move" needs its own identity. The log labels each focused element for
humans, but two different `<input>`s both report the bare string `INPUT`, so a
working trap looked like a broken one on three dialogs at once. The advance
check compares a key built from tag + `name` + `id` + position in the panel's
focusable list instead.

Ten `role="dialog"` overlays are covered (including the two icon-only shared
chrome triggers), and the two hand-built sheets are reached on their own visit
rather than hunted: the mobile nav drawer at `375×667` — its trigger is
`md:hidden`, so a probe hunting at desktop width can never see it — and the POS
cart sheet.

Four real defects this found, all fixed in the app rather than in the probe:

1. **The drawer claimed to be a modal while closed.** It has to stay mounted
   (the slide-in is a `translate`, and unmounting would kill the transition), so
   `role="dialog" aria-modal="true"` sat on a panel that is *permanently* open
   as far as assistive tech is concerned: the page behind it announced as inert
   forever, and every nav link still tabbable. It now carries the role,
   `aria-modal` and the trap **only while open**, and is `inert` +
   `aria-hidden` while closed. This one also broke the probe itself — the
   permanently-present dialog was counted as "the overlay that was clicked" on
   ten of eleven measurements.
2. **No dialog could hand focus back.** Radix restores focus to
   `DialogTrigger`, and **not one dialog in this app renders one** — every one
   is opened from a plain button with a controlled `open` prop. Focus fell to
   `<body>` on close in eight of them. `DialogContent` now remembers the opener
   in `onOpenAutoFocus` (the one moment it is still recoverable) and restores it
   in `onCloseAutoFocus`, which also suppresses Radix's own trigger restore so
   the two cannot fight.
3. **Three hand-rolled overlays claimed modality and implemented none of it.**
   The command palette, the shortcuts modal and the image lightbox now share one
   `useModalFocus` hook: focus in on open, `Tab` trapped (in the **capture**
   phase, so no later handler and no browser default can move focus first), and
   focus back to the opener on close. The opener is captured in a **layout**
   effect — a passive effect is already too late, because a sibling effect that
   focuses the panel's own field is declared after the hook and would have
   recorded "something inside the panel" as the opener.
4. **The POS page stole focus on every dialog state change.** Its keyboard
   shortcut effect re-subscribes whenever a dialog opens or closes, and its
   first statement focused the scan field — so opening a dialog yanked focus out
   of the panel, and closing one stole it from the trigger Radix had just
   restored. That focus call is mount-only now; the cashier's explicit paths
   (`F2`, `F10`, a new sale) still return to the scan field.

The POS mobile cart sheet, the fifth hand-rolled overlay, was wired through the
same hook once the scan found it claiming `aria-modal` with no trap at all. The
lightbox is fixed the same way but is not geometry-probed (see *Known gaps*).

The static half of this contract is `tests/modal-focus-contract.test.ts`: a file
that says `aria-modal` must build on `<DialogContent>` or call `useModalFocus`,
and a panel that traps focus must declare its role. The probe above is the live
half — a new overlay has to pass both.

### Anchored popovers and the lightbox

Menus and listboxes are the other half of "overlay layout", and the generic
trigger hunt cannot reach them: their triggers are named `Export` (on the
never-click list, because an export **is** an action), `Currency`, or nothing at
all. Each is therefore opened by an explicitly named trigger — opening a menu is
not an action, and the probe never clicks an *item* — and then measured twice:
where it opens, and again at `375×667`, because a panel pinned to its trigger's
**end** edge is exactly how a dropdown ends up off the side of a phone.

| Popover | Role | Opened from |
| --- | --- | --- |
| display-currency picker | `listbox` + `option` | `header button[aria-haspopup="listbox"]` |
| theme picker | `menu` + `menuitemradio` | first `header button[aria-haspopup="menu"]` |
| export menu | `menu` + `menuitem` | `main button[aria-haspopup="menu"]` |

The **identity** of the panel is checked, not assumed: the role and the item
kind have to match the spec, so a trigger whose order changed reports a mismatch
instead of quietly measuring a plausible neighbour. Per popover the audit then
asserts: it fits and adds no page overflow at both widths, taller content stays
reachable, opening never leaves focus on `<body>`, `ArrowDown` walks to another
item, `Escape` closes it, and focus goes back to the trigger — at both widths.

That last group is new *behaviour*, not new assertions. Three of the four
anchored popovers could not have passed it before:

* the **currency picker** closed on outside click only — `Escape` did nothing
  and closing left focus on `<body>`;
* the **export menu** had an `Escape` handler but no arrow keys and no `Tab`
  handling;
* the **theme picker** had neither, and its three options were emoji
  (`☀️ 🌙 💻`) — the last glyph-font icons in the app, against this project's
  inline-SVG rule. It is now `menu` + `menuitemradio` with `aria-checked`, which
  is also the only thing that tells a screen reader which scheme is active.

All four now share `usePopoverMenu`: focus lands on the checked item (or the
first), arrows walk and wrap, Home/End jump, `Escape` closes **and** hands focus
back, and `Tab` closes then continues from the trigger rather than from inside a
panel that is about to disappear. That is deliberately *not* the modal contract —
a popover must not trap.

The **image lightbox** is measured too, and it is the case that shows why the
probe distinguishes behaviour from geometry. Its trigger is a thumbnail (an
image click, which no name-based hunt finds) and its root is full-bleed by
design, so what must fit is the frame inside. But the seeded database has no
product images, so the frame has nothing to size it — measuring the close button
instead would be exactly the vacuous check this file exists to avoid. The
audit therefore asserts what is image-independent: it opens from a thumbnail as
a `dialog`, focus moves inside, `Tab` stays trapped, no state inside it
introduces a legacy colour, `Escape` closes it, and focus returns to the
thumbnail. The **cap** that makes an arbitrarily large image safe
(`90vw`/`90vh`, with the image inset a further 8px for the bezel) is asserted
statically in `audit:neu` instead.

### The ratchet

Both audits fail if the migrated system regresses. All of these are **zero**:

| Guard | Value |
| --- | --- |
| legacy surface token in TSX (print paper excepted) | **0** |
| legacy focus indicator (one neu ring instead) | **0** |
| `*-neu-*` utility referenced but not compiled | **0** |
| `--color-brand-*` accent in TSX | **0** |
| retired brand-blue literal in markup (`#3b82f6`) | **0** |
| raw Tailwind palette hue anywhere in `src` (no exemptions left) | **0** |
| legacy status-palette utility, or `var(--color-<status>-N)`, anywhere | **0** |
| emoji or icon-font glyph in the UI (`src/**/*.tsx`) | **0** |
| vivid accent used as text instead of that hue's ink role | **0** |
| icon-only control in the shell with no accessible name | **0** |
| unnamed `<nav>` landmark, or a rail row without `aria-current` | **0** |
| rail not icon-only below `lg`, or labels not width-gated | **0** |
| collapsed rail that does not widen the content measure | **0** |
| shell with no skip link, or a `<main>` that cannot take focus | **0** |
| physical direction utility in TSX outside the named exemptions | **0** |
| physical layout property in `globals.css` (light edges excepted) | **0** |
| LTR island that is not the clock or a print facsimile | **0** |
| LTR island with no stated reason | **0** |
| clock with no readout below `xl`, or no value in words | **0** |
| rail's primary action collapsed to a textless sliver | **0** |
| physical `left-*` / `right-*` / `text-left` in the shell | **0** |
| physical `left-*`/`right-*` anchoring on the toast or sync stack | **0** |
| bar lift that is not the `--neu-shadow-bar` token | **0** |
| `<Button>` nested inside a link (one action, one control) | **0** |
| breadcrumb that is not a labelled list with `aria-current` | **0** |
| `vh`-based sizing in TSX (dvh only) | **0** |
| `group-*` / `peer-*` variant without its marker class in `src` | **0** |
| page using a `group-*` / `peer-*` variant without its own marker | **0** |
| keyframe translate doubling an element's `translate-*` utility | **0** |
| legacy surface colour in the live DOM (6 pages) | **0** |
| legacy focus-indicator utility in the live DOM | **0** |
| legacy colour introduced by `:hover` / `:focus` | **0** |
| hover affordance whose forced `:hover` changes nothing | **0** |
| focused `.neu-focus` not painting the ring | **0** |
| legacy colour introduced by `:active` / `:disabled` / `group-*` / `peer-*` | **0** |
| press or disabled affordance that paints nothing | **0** |
| disabled control whose ink equals its own fill | **0** |
| `group-*` / `peer-*` utility without its marker class in the live DOM | **0** |
| overlay that does not fit the viewport at 1440×900 / 768×1024 / 375×667 | **0** |
| overlay content taller than its panel and not scroll-reachable | **0** |
| overlay measured that is not the one that was clicked | **0** |
| palette with no entry point at phone width (375×667) | **0** |
| shared header clipped at 375 / 768 / 1024 / 1440 (nothing open) | **0** |
| resting page with horizontal overflow at any of those widths | **0** |
| rail that is labelled below `lg`, or not 72px/260px where it should be | **0** |
| rail collapse that leaves the table/mains at the same width | **0** |
| keyboard stop between the top and the content with no name | **0** |
| focusable element inside the CLOSED mobile drawer | **0** |
| clock showing the dial and the compact form at once (or neither) | **0** |
| page stop after `main` that is unnamed, invisible or `aria-hidden` | **0** |
| table whose rows differ by more than 8px, or leave the 36–76px band | **0** |
| document overflow, or a mirrored rail/cluster, in RTL at 1440/375 | **0** |
| table header that does not hug the mirrored edge in Urdu | **0** |
| first table column that does not move to the leading edge in Urdu | **0** |
| toast / sync stack docked to a physical edge, or a flip that sticks | **0** |
| probe click that navigated away from its page | **0** |
| modal that does not move focus inside when it opens | **0** |
| modal whose `Tab` leaves the panel, or does not advance at all | **0** |
| overlay that does not hand focus back to what opened it | **0** |
| `aria-modal` overlay with no focus contract (static) | **0** |
| hand-rolled focus-trapped panel with no `role="dialog"` (static) | **0** |
| anchored popover that does not fit at 1440 / 375 | **0** |
| anchored popover that puts focus on `<body>` when it opens | **0** |
| anchored popover whose `ArrowDown` does not walk its items | **0** |
| popover whose `Escape` does not hand focus back to its trigger | **0** |
| image lightbox that does not move focus in / return it on close | **0** |

It runs in CI (`.github/workflows/ci.yml`, after lint) using the Chrome that
ships with the runner — so a theme regression fails the build. `CHROME_PATH`
overrides the browser binary if the image moves it.

## Deliberate deviations

1. **`.neu-btn` does not force `width: 100%`.** The spec's "full width" is the
   form CTA, but ~170 call sites use buttons in toolbars, table rows and icon
   slots. Full width is opt-in via `.neu-btn-block` (the auth CTAs use it).
2. **`.neu-card-flush` exists.** `Card`, the dialog panel and the lightbox frame
   own their inner padding, so the recipe's `36px 28px` would double-pad them.
   Panels that are not split into header/content use plain `.neu-card`.
3. **The image frame is opt-in** (`SmartImage framed`, the lightbox). SmartImage's
   wrapper is size-owned by its caller (44px avatars, full-bleed POS tile art,
   gallery cells); imposing 8px padding + a raised emboss on every slot would
   break those layouts. The `<img>` is never shadowed either way.
4. **Chart containers are not wrapped in `.neu-card`.** Charts are renderers whose
   container is owned by the caller, and every chart in this app already sits
   inside a `Card` — which *is* the neu card. Wrapping again would nest cards.
5. **`TableSkeleton` stays `<tr>`-based.** It renders inside a real
   `<table><tbody>`, so the spec's 8px "gap" is applied as 8px of cell padding
   rather than `gap` (which only exists on flex/grid).
6. **The separator resolves to 2px total.** The spec's own recipe is a 1px dark
   line over a 1px light line, so the element is 2px tall; each border is 1px.
7. **`.skeleton` is kept as an alias** of `.neu-skeleton` so the ~8 existing
   call sites did not need touching.
8. **Ink is used where the accent would fail.** Icons, labels, chips, headings and
   delta values use the same-hue `--neu-ink-*` rather than the vivid accent. The
   hues read identically; only lightness changes. This is the fix for the
   contrast failures that the spec's accent-only treatment produced.
9. **The `Label` has no disabled state of its own.** A
   `peer-disabled:cursor-not-allowed peer-disabled:opacity-70` pair used to sit
   on it and was **dead**: every `Label` in this app renders *before* its
   control (and inside its own wrapper), so no `.peer` sibling can ever precede
   it and the selector could never match. The muted state belongs to the
   control, which already carries it in `.neu-input:disabled` /
   `.neu-btn:disabled`. Removed rather than left as decoration — and
   `audit:neu` now fails if any `group-*`/`peer-*` variant has no marker class
   to key off.
10. **The dialog entrance animates `scale`, not `transform`.** Tailwind v4
    centres the panel with the `translate` *property*, which **composes** with a
    `transform` instead of overriding it. The keyframe used to repeat
    `translate(-50%,-50%)` "so the panel doesn't jump" — which applied the
    centring twice and pushed **every dialog in the app** half its own size up
    and to the left, off-screen at 375×667. Found by measuring real dialog
    geometry, now guarded statically as well.
11. **Two surfaces keep non-embossed chrome, on purpose.**

   * *Lightbox chrome* (`.lightbox-close` / `-arrow` / `-counter`) sits on the
     scrimmed backdrop, not on the page surface. An emboss needs a mid-tone
     surface to read as depth, and there is none there — so these stay bold white
     on a translucent-white fill and consume the neu radius scale. Guarded by the
     `lightbox: …` audit checks.
   * *The barcode label* is a print artefact: pure white paper + `#000` ink for
     scanner legibility, with the emboss removed under `@media print`.
12. **The drawer is a dialog only while it is open.** It could have kept a
    static `role="dialog" aria-modal="true"`, but staying mounted for the sake
    of a CSS transition would then have meant announcing a permanently-open
    modal over every page — the page behind it inert forever and its links still
    tabbable. `role`, `aria-modal` and the focus trap are all conditional on the
    open state, and the closed drawer is `inert` + `aria-hidden`. One source of
    truth per state, at the cost of two ternaries.
13. **`DialogContent` restores focus itself, and the POS scan field does not.**
    Radix's restore targets `DialogTrigger`, which this codebase never renders,
    so the wrapper remembers the opener instead. Symmetrically, the POS page's
    scan field used to be focused from an effect whose dependencies are the
    dialog states — re-focusing on every open and close. It is mount-only now,
    because a page-level focus() that fires on modal state changes will always
    lose to, or win wrongly against, the modal's own focus management.

14. **The anchored popovers clamp themselves, and drop to a sheet on a phone.**
    A panel pinned to its trigger's *end* edge is exactly how a dropdown ends
    up off the side of a handset: the export menu measured **33px past the
    right edge** at 375×667. It is a bottom sheet below `sm` (`fixed inset-x-2
    bottom-4`, full width) and an end-anchored panel above it, clamped by
    `max-w-[calc(100vw-1rem)]`; every popover is measured at both widths by the
    page audit rather than trusted to its anchoring. The four share one
    keyboard contract (`usePopoverMenu`) — deliberately **not** the modal one,
    because a popover must not trap focus.
15. **The shell's "where am I" is a `<span>`, not a heading.** It is genuine
    page context, and a heading is the semantic default for a title — but every
    page already renders its own `<h1>`, so a second one in shared chrome would
    add a phantom stop to heading navigation. The label is read in document
    order instead.
16. **The rail repeats the signed-in user.** The account menu is the canonical
    place for identity, and the rail's block is a second surface for the same
    two facts. It earns the duplication: the role chip is what a cashier is
    told to check when a control they expect is missing, and the rail is the
    only chrome that is on screen while every page is being used.
17. **The rail is icon-only below `lg`, whatever the user chose.** The
    preference is respected from `lg` up and overridden below it, because that
    188px is the difference between a bar with every control visible and one
    whose tail is clipped — and because a tablet is a touch device, where a
    labelled rail is a luxury rather than a requirement. The override is by
    width (CSS), not by state, so an expanded preference is not silently
    rewritten in the store: widen the window and the labels come back.
18. **The skip link is a visible button when focused.** `sr-only` + a raised
    `.neu-btn` pill on `focus:not-sr-only`, rather than the usual bare text
    link: it is a control, it should look like one the moment it is reachable,
    and it is the first stop in the tab order — so whatever it looks like is
    what the first keystroke of the session shows you.
19. **`<main>` is focusable (`tabIndex={-1}`), and the content cap moves with
    the rail.** Both are consequences of the same decision — that the shell
    serves the content. A skip link that only scrolls is a half-fix, and a rail
    that collapses without the measure following it just centres the same table
    in a wider box.
20. **The emboss does not mirror in RTL; only the layout does.** The obvious
    symmetry argument says the light should come from the other side in Urdu,
    and it is wrong: a light source is a property of the room, not of the
    reading direction, and the top-left light is what makes the raised/inset
    pair read as one material. So `--neu-shadow-raised` keeps its `6px 6px`
    first offset under `[dir="rtl"]` — and so does the *vertical separator*,
    whose `border-left`/`border-right` pair is the same light edge and lit edge,
    not a layout anchor. The audit asserts both (a mirror is a perfectly
    plausible future "fix" that would make every surface in the app disagree
    with itself). This is the same rule the migration applies to every class
    string: **layout anchors are logical; light is physical.**
21. **Reserved lines instead of content-driven row heights.** Products reserves
    a 14px brand line and orders reserves a 14px balance line even when there is
    nothing to show. It reads as a slightly airier row than the data strictly
    needs — and the alternative is worse: a table whose rows resize per record,
    with the row height silently encoding "has a brand" / "owes money". The
    products table is the clearest case, because one line is *empty* on most
    rows; the room it takes is what makes the other rows' position predictable.
22. **A direction-NEUTRAL gesture keeps its physical form.** One case is neither
    layout nor light: a dialog centred by `left: 50%` + `translateX(-50%)`. The
    two halves cancel into a symmetric placement that is identical in both
    scripts, so translating one half to `start-` would move the panel by half
    its own width in RTL only. It is named as an exemption in the ratchet
    instead of being "fixed", and the same reasoning covers
    `.lightbox-counter`. (`-translate-y-1/2` on a field's icon is not in this
    class: it is vertical, and it mirrors nothing.)
23. **Two surfaces are pinned LTR *inside* the UI: the clock and the receipt
    facsimiles.** Neither is prose. The clock's digits and meridiem read the
    same way in Urdu, and its sweep is a physical direction. A receipt previews
    `print-pos-receipt.ts`, which is `lang="en"` with physical ink geometry —
    so a mirrored preview would show the operator something the printer will not
    produce, down to which side each amount lands on. They therefore declare
    `dir="ltr"` and use *logical* utilities inside it, which is what keeps the
    ratchet strict: an island is a direction claim, so it is named (and has to
    state its reason) rather than being an exemption for physical classes.

## Known gaps

* **Density is asserted as uniformity plus a band, not as a target height.**
  Rows must be within 8px of each other and inside 36–76px. That catches the two
  failure modes that matter (rows that resize per record, and rows that are
  simply too tall to scan) without pretending a single ideal height exists for a
  products grid, a stock list and an audit log.
* **The RTL pass measures the shell, the drawer, the two docked stacks and one
  data page's table.** The rail side, the drawer edge, the cluster order, the
  clock island, the toast/sync docking, the products table's per-column edge
  (read from a Range over each header's own text, not from a class name) and its
  first column's move to the leading edge are all measured in Urdu at 1440 and
  1280. The *other* pages are covered by the static ratchet instead of by a
  measurement each: one page's table exercises the shared table plumbing, and
  the ratchet is repo-wide, so a physical utility anywhere in `src` fails the
  build whether or not a probe ever renders that file. What is still unmeasured
  is a page whose *own* bespoke layout (not the shared table/chip/field recipes)
  would mirror wrongly — the products page is the probe's stand-in for that.
* **`translate-x-*` is deliberately NOT part of the migration.** A transform is
  a physical gesture: the drawer's state pair (`-translate-x-full
  rtl:translate-x-full`), the switch thumbs' (`translate-x-6 rtl:-translate-x-6`)
  and the hover arrow's are already written as explicit two-direction pairs, and
  a codemod that swapped them would break both directions at once. The codemod
  reports any span that carries a `translate-x-*` and skips its `left-*`/`right-*`
  (that is how the dialog's symmetric centering survives), so the conversions it
  cannot make safely are visible instead of silent — but the pairs themselves are
  hand-written and only measured in the shell.
* **The emoji rule covers `src/**/*.tsx`, not the CLI.** The seed runner
  (`src/app/api/seed/seed-runner.ts`) prints `✓`/`🌱` marks to a terminal, where
  a glyph is the right vocabulary and there is no icon layer to prefer. The
  check is deliberately `.tsx`-only for that reason.
* **The legacy-value scan is light-mode derived.** Dark mode legitimately uses
  values that coincide with the light legacy palette (`#94a3b8` is *both*
  `surface-400` and dark `--neu-text-muted`), so a "legacy value" is only
  unambiguous in light mode. Dark is covered instead by **positive** assertions
  on the real pages — the dark surface and dark body ink are the dark tokens,
  and no light token value survives the flip — plus `audit:neu`, which compiles
  the stylesheet and reads a fixture in both modes.
* **The state probes are capped** (45 hover / 35 focus / 25 press / 25 disabled /
  45 relational per page) so the run stays bounded. The cap is printed as
  `probed/total`, so a page with more affordances than the cap has its tail
  unprobed — visible, not silent.
* **The generic trigger hunt only discovers additive-looking buttons; the
  overlays it cannot reach are named explicitly.** Its selector covers `dialog`,
  `alertdialog`, `menu` and `listbox`, but "click the first additive button"
  finds neither a menu raised by `Export` nor a panel raised by clicking a
  thumbnail — so those are listed by hand (`POPOVERS`, `LIGHTBOX_PANEL`) and
  opened from their real triggers, which is also why their identity is asserted
  (role + item count + heading) rather than assumed. Three popovers are still
  reached only through a gesture the probe does not script: the inventory
  product combobox and the orders status listbox (both opened by typing a
  filter) and the header's second `aria-haspopup` menu (two same-shaped triggers
  make "the first one" ambiguous). All three share `usePopoverMenu` and are
  covered by the static contract checks, but their *geometry* is not measured.
* **A relational variant can only be orphan-checked where its target renders.**
  The DOM orphan check sees elements present at rest or inside an opened dialog.
  A `group-*`/`peer-*` utility inside a popover that the probe never opens is
  invisible to it — which is why the same guarantee is *also* asserted
  statically against the source, where opening nothing is required.
* **One bespoke hue is left, by name.** The clock's old palette is gone (see
  the phase-8 note): its hands are `--neu-text-primary`, its second hand
  `--neu-ink-red`, its sweep `--neu-accent-line`, its day/night badge
  `--neu-ink-amber` / `--neu-ink-cyan`. What remains is the *second* chart
  series, `#8b5cf6` — there is no neu violet, and the audit names that one
  literal explicitly (`SERIES_RAW_ALLOWED`) so it stays visible instead of
  hiding behind a pattern. The barcode scanner's laser glow reads
  `rgb(var(--neu-cyan-rgb) / …)`; the first chart series is
  `var(--neu-accent-line)`.
* **The lightbox's geometry is asserted statically, not measured.** Its frame
  cap is checked against the viewport in `audit:neu`; the live probe cannot
  measure it because the seeded database has no product images to size the
  frame. A run against a database with images would exercise the live path too —
  the behavioural half is already covered.
* **Print and export ride the same accent as the screen.** `print-brand.ts` and
  `csv.ts` resolve `--neu-accent-ink` / `-strong` / `-tint` out of `globals.css`
  — `tests/print-brand-sync.test.ts` parses the stylesheet (comments stripped)
  and fails if the two drift — so exported paperwork carries the same cyan. The
  one true exception is `.barcode-label-card`: pure white paper + `#000` ink for
  scanner legibility, with the emboss removed under `@media print`.
* **Colour is never the only signal.** Every accent-carrying state also has a
  non-colour cue (weight, a border, an icon, a wash) — the accent set is AA, but
  the system does not rely on hue alone.

## WCAG contrast report

Measured against `--neu-bg` (light `#e6ecf0`, dark `#1e293b`). Every row below
the divider is **computed by the audit in a real browser**, so it cannot drift
from the tokens.

### Pass

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `--neu-text-primary` `#334155` on `#e6ecf0` | **8.27:1** | AA + AAA |
| `--neu-text-muted` default `#475569` on `#e6ecf0` | **6.36:1** | AA |
| `--neu-text-faint` `#5a6779` / dark `#8a97a8` | **4.83:1 / 4.93:1** | AA (narrow — meta text only) |
| primary under `prefers-contrast: more` `#1e293b` | **12.28:1** | AAA |
| muted under `prefers-contrast: more` `#334155` | **8.27:1** | AAA |
| faint under `prefers-contrast: more` `#475569` | **6.36:1** | AA (ladder kept ordered) |
| accent ink `#155e75` / dark `#22d3ee` | **6.10:1 / 8.09:1** | AA |
| accent ink-strong `#164e63` / dark `#67e8f9` | **7.65:1 / 10.09:1** | AA |
| accent ink **on `--neu-accent-wash`** | **5.36:1 / 6.00:1** | AA |
| accent line ( = focus ring) `#0891b2` / dark `#22d3ee` | **3.09:1 / 8.09:1** | SC 1.4.11 (3:1) |
| white ink on `--neu-accent-solid` `#0e7490` | **5.36:1** | AA |
| dark primary `#f1f5f9` on `#1e293b` | **13.33:1** | AAA |
| dark muted `#94a3b8` on `#1e293b` | **5.70:1** | AA |
| ink cyan `#155e75` / dark `#22d3ee` | **6.10:1 / 8.09:1** | AA |
| ink green `#166534` / dark `#4ade80` | **5.98:1 / 8.40:1** | AA |
| ink amber `#92400e` / dark `#fbbf24` | **5.95:1 / 8.76:1** | AA |
| ink red `#b91c1c` / dark `#f87171` | **5.43:1 / 5.29:1** | AA |
| each ink **on its own wash** cyan / green / amber / red | **5.92 / 5.65 / 5.65 / 4.93:1** light, **6.70 / 7.33 / 7.67 / 4.96:1** dark | AA (the washes are 8% accent, so the hue reads without eating the ratio) |
| focus ring `#0891b2` / dark `#22d3ee` | **3.09:1 / 8.09:1** | passes SC 1.4.11 (3:1) |
| `.neu-badge-solid` fills + near-black ink | **4.97–11.90:1** | AA |

### Resolved before shipping

| Pair | Ratio | Resolution |
| --- | --- | --- |
| spec `--neu-text-muted` `#64748b` on `#e6ecf0` | **3.99:1** — fails AA | Adopted the `prefers-contrast` value `#475569` (6.36:1) as the *default* muted token, per decision. `#64748b` is no longer used. |
| focus indicator `--neu-accent-cyan` `#00f2fe` | **1.16:1** — fails SC 1.4.11 | Added `--neu-focus-ring` (`#0891b2` light / `#22d3ee` dark) and pointed the global `:focus-visible`, `.neu-focus`, `.neu-input`/`.neu-select` and `.inv-select` rings at it. `--neu-accent-cyan` is still the *glow* colour, via `--neu-focus-rgb`. |
| badge / delta / status-heading / toast-icon accents | **1.16–3.16:1** — fail AA at 12–16px | Added the `--neu-ink-*` set; every text and glyph now uses it. Enforced per-ink by the audit. |
| button danger hover text `#ef4444` | **3.16:1** — fails AA at 16px/600 | Hovers to `--neu-ink-red` (**5.43:1**). |
| non-text accent icons (stat cards, toasts) | **1.16–3.16:1** — below 3:1 | Now use `--neu-ink-*` (5.4–6.1:1). The tone is *also* carried by an accent line and a colour wash, so colour is never the only signal. |
| solid status badge's white glyph on `--neu-accent-green` | **2.28:1** (amber **2.15:1**) — below 3:1 | Kept the spec's solid accent circle but moved the **fill** to the mode-stable `--neu-solid-*` set: **5.02 / 5.02 / 6.47:1** on `--neu-solid-green/amber/red`. Asserted per variant in both modes. |
| legacy `text-surface-400` / `-500` in page markup | **2.6:1 / 3.99:1** — below AA at 12–14px | The phase-3 codemod maps them to `--neu-text-faint` (**4.83:1**), so the densest meta text in the app now clears AA too. |
| legacy brand-blue accent text `#2563eb` on `#e6ecf0` | **4.49:1** — *just* under AA | Phase 4 moved accent text to `--neu-accent-ink` (**6.10:1**). |
| legacy brand-blue **borders/rings** `#3b82f6` / `#93c5fd` | **3.09:1 / 1.45:1** | Every accent edge is now `--neu-accent-line` ( = the focus ring, **3.09:1**). The old `border-brand-200` was a **1.45:1** boundary, i.e. invisible under SC 1.4.11. |
| `hover:bg-surface-50` beside `bg-surface-50` (dead hovers) | n/a — never painted | Phase 4's suffix/axis guard drops them; the pages audit now fails if any affordance's forced `:hover` changes nothing. |
| `dark:bg-danger-500/15 dark:text-danger-500` (the legacy semantic wash) | **4.26:1** — failed AA on the dark surface | The four washes are now **8% of the vivid accent mixed into `--neu-bg`**, so one declaration is AA in *both* modes. Measured ink-on-wash: cyan **5.92 / 6.70**, green **5.65 / 7.33**, amber **5.65 / 7.67**, red **4.93 / 4.96** (light / dark). The 8% strength is guarded, so a future edit cannot quietly weaken the hue away from legibility. |
| 237 semantic class strings (`bg-success-500/15`, `text-danger-500`, `border-warning-500/30`, …) | n/a — legacy vocabulary | Migrated by the suffix-aware codemod onto `bg-neu-wash-*` / `text-neu-ink-*` / `border-neu-ink-*`. The only survivors are the bespoke clock's `via-info-*` gradient and the legacy `--color-*` palette itself, which `print-brand.ts` mirrors (pinned by `tests/print-brand-sync.test.ts`). |
| chart / series colours `var(--color-<hue>-500)` | **2.26:1** on the dark `--neu-bg` (`#b91c1c`) | Chart and series configs now use the **mode-aware ink** roles. The `--neu-solid-*` set is *glyph-on-fill* — correct against `#fff`, wrong on the page surface — so it must not be used for anything drawn on the surface. |

### Known limitations — flagged, not silently changed

1. **~~Chart data marks keep the legacy brand blue~~ — resolved.** The first
   series is now `var(--neu-accent-line)` (**3.09:1** light / **8.09:1** dark), so
   the data follows the theme *and* clears the 3:1 graphics minimum in both modes.
   It is pointed at the `line` cyan rather than `--neu-accent-cyan`, which would
   have dropped the data to **1.16:1**.
2. **~~The neu system ships two light-mode inks~~ — resolved.** A third step,
   `--neu-text-faint`, now exists (`#5a6779` / `#8a97a8`, both AA), so the five-step
   grey ladder in the data tables keeps *three* real steps instead of collapsing
   to two. It is deliberately narrow (4.83:1 — AA with very little headroom) and
   must not be used for body copy; the audit asserts the ladder stays ordered and
   AA, in both modes and under `prefers-contrast: more`.
