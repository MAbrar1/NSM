# CODEBASE STRUCTURE AUDIT — NSM POS (Elite-POS)

> ⚠️ Point-in-time snapshot: taken **before** the repo-structure cleanup
> (`chore/repo-structure-cleanup`). Root loose scripts, tracked build
> output, and the flat `src/lib/` layout described below have since been
> reorganized — see the cleanup commits for the current shape.

Read-only structural audit. Branch: `feature/print-receipt-scan`.
Excluded from all output: `node_modules`, `.next`, `.git`, `dist`, `build`, `out`, `coverage`, `.turbo`, `.cache`, `.vercel`, `.idea`, `.vscode`, `*.log`, `.DS_Store`, `.env*` (`.env.example` reported by name only in §4), lockfile contents.

---

## 1. Directory tree

```
├── .env.example
├── .gitignore
├── .prettierrc
├── CODEBASE_STRUCTURE_AUDIT.md
├── eslint.config.mjs
├── next-env.d.ts (generated; gitignored — see .gitignore)
├── next.config.ts
├── NSM_PRINT_TASK.md
├── package.json
├── package-lock.json
├── postcss.config.mjs
├── tsconfig.json
├── tsconfig.tsbuildinfo
├── .github/
│   └── workflows/
│       └── ci.yml
├── docs/
│   ├── DATABASE-MIGRATIONS.md
│   ├── DESIGN-NEUMORPHISM.md
│   └── GOLDEN-ELITE.md
├── prisma/
│   ├── dev.db (1.2 MB)
│   ├── dev.db.backup-20260918 (0.7 MB)
│   ├── dev.db.bak-before-runninglow (1.0 MB)
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
│       ├── migration_lock.toml
│       ├── 20260929120000_print_receipt_scan/
│       │   └── migration.sql
│       ├── 20260930120000_receipt_urdu_digits/
│       │   └── migration.sql
│       └── 20260930130000_palette_recents/
│           └── migration.sql
├── public/
│   ├── fonts/ (14 woff2 files, 0.57 MB + licenses/ 5 OFL txt)
│   │   └── licenses/ (5 files)
│   └── (no other asset folders)
├── samples/ (7 files — print HTML samples ×6, xlsx ×1)
├── scripts/ (20 files, see below)
├── src/
│   ├── instrumentation.ts
│   ├── middleware.ts
│   ├── app/
│   │   ├── globals.css
│   │   ├── icon.svg
│   │   ├── layout.tsx
│   │   ├── not-found.tsx
│   │   ├── page.tsx
│   │   ├── login/
│   │   │   └── page.tsx
│   │   ├── register/
│   │   │   └── page.tsx
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx
│   │   │   ├── customers/
│   │   │   │   └── page.tsx
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx
│   │   │   ├── inventory/
│   │   │   │   └── page.tsx
│   │   │   ├── orders/
│   │   │   │   └── page.tsx
│   │   │   ├── pos/
│   │   │   │   └── page.tsx
│   │   │   ├── products/
│   │   │   │   └── page.tsx
│   │   │   ├── purchase-orders/
│   │   │   │   └── page.tsx
│   │   │   ├── refunds/
│   │   │   │   └── page.tsx
│   │   │   ├── suppliers/
│   │   │   │   └── page.tsx
│   │   │   ├── users/
│   │   │   │   └── page.tsx
│   │   │   ├── reports/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── inventory/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── profit-loss/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── sales/
│   │   │   │       └── page.tsx
│   │   │   └── settings/
│   │   │       ├── page.tsx
│   │   │       ├── audit-log/
│   │   │       │   └── page.tsx
│   │   │       ├── print-center/
│   │   │       │   └── page.tsx
│   │   │       ├── printers/
│   │   │       │   └── page.tsx
│   │   │       ├── receipts/
│   │   │       │   └── page.tsx
│   │   │       ├── roles/
│   │   │       │   └── page.tsx
│   │   │       └── users/
│   │   │           └── page.tsx
│   │   └── api/
│   │       ├── activity/route.ts
│   │       ├── alerts/route.ts
│   │       ├── audit-log/route.ts
│   │       ├── dashboard/route.ts
│   │       ├── health/route.ts
│   │       ├── palette-recents/route.ts
│   │       ├── refunds/route.ts
│   │       ├── scan-settings/route.ts
│   │       ├── search/route.ts
│   │       ├── seed/
│   │       │   ├── route.ts
│   │       │   └── seed-runner.ts
│   │       ├── settings/
│   │       │   ├── route.ts
│   │       │   └── currency/route.ts
│   │       ├── auth/
│   │       │   ├── [...nextauth]/route.ts
│   │       │   ├── register/route.ts
│   │       │   ├── registration-status/route.ts
│   │       │   └── session/route.ts
│   │       ├── brands/
│   │       │   ├── route.ts
│   │       │   └── [id]/route.ts
│   │       ├── categories/
│   │       │   ├── route.ts
│   │       │   └── [id]/route.ts
│   │       ├── customers/
│   │       │   ├── route.ts
│   │       │   ├── import/route.ts
│   │       │   └── [id]/
│   │       │       ├── route.ts
│   │       │       ├── payments/route.ts
│   │       │       └── statement/route.ts
│   │       ├── files/
│   │       │   └── [name]/route.ts
│   │       ├── fx/
│   │       │   └── rates/route.ts
│   │       ├── inventory/
│   │       │   ├── route.ts
│   │       │   ├── adjust/route.ts
│   │       │   ├── movements/route.ts
│   │       │   ├── restock/route.ts
│   │       │   ├── reserve/
│   │       │   │   ├── route.ts
│   │       │   │   └── cleanup/route.ts
│   │       │   └── transfer/
│   │       │       ├── route.ts
│   │       │       └── [id]/route.ts
│   │       ├── maintenance/
│   │       │   └── run/route.ts
│   │       ├── notifications/
│   │       │   ├── log/route.ts
│   │       │   └── low-stock/
│   │       │       ├── route.ts
│   │       │       └── run/route.ts
│   │       ├── orders/
│   │       │   ├── route.ts
│   │       │   ├── bulk-refund/route.ts
│   │       │   └── [id]/route.ts
│   │       ├── pos/
│   │       │   ├── checkout/route.ts
│   │       │   └── search/route.ts
│   │       ├── printer-profiles/
│   │       │   ├── route.ts
│   │       │   └── [id]/route.ts
│   │       ├── products/
│   │       │   ├── route.ts
│   │       │   ├── bulk/route.ts
│   │       │   ├── import/route.ts
│   │       │   ├── lookup/route.ts
│   │       │   └── [id]/
│   │       │       ├── route.ts
│   │       │       ├── image/route.ts
│   │       │       └── variants/
│   │       │           ├── route.ts
│   │       │           └── [variantId]/route.ts
│   │       ├── purchase-orders/
│   │       │   ├── route.ts
│   │       │   ├── import/route.ts
│   │       │   └── [id]/route.ts
│   │       ├── receipts/
│   │       │   ├── lookup/route.ts
│   │       │   └── [id]/
│   │       │       └── reprint/route.ts
│   │       ├── reports/
│   │       │   ├── inventory/route.ts
│   │       │   ├── profit-loss/route.ts
│   │       │   ├── receivables/route.ts
│   │       │   └── sales/route.ts
│   │       ├── suppliers/
│   │       │   ├── route.ts
│   │       │   ├── import/route.ts
│   │       │   └── [id]/route.ts
│   │       ├── system/
│   │       │   └── jobs/route.ts
│   │       └── users/
│   │           ├── route.ts
│   │           └── [id]/route.ts
│   ├── components/
│   │   ├── export/
│   │   │   └── export-menu.tsx
│   │   ├── import/
│   │   │   └── import-result-dialog.tsx
│   │   ├── layout/
│   │   │   ├── dirty-nav-guard.tsx
│   │   │   ├── live-clock.tsx
│   │   │   ├── notification-bell.tsx
│   │   │   ├── page-header.tsx
│   │   │   ├── sync-indicator.tsx
│   │   │   └── welcome-modal.tsx
│   │   ├── pos/
│   │   │   ├── barcode-scanner.tsx
│   │   │   └── customer-picker.tsx
│   │   ├── print/
│   │   │   └── print-preview.tsx
│   │   ├── products/
│   │   │   ├── barcode-label.tsx
│   │   │   ├── image-gallery-upload.tsx
│   │   │   ├── product-form.tsx
│   │   │   └── product-variants.tsx
│   │   ├── providers/
│   │   │   ├── currency-picker.tsx
│   │   │   ├── currency-provider.tsx
│   │   │   ├── i18n-provider.tsx
│   │   │   ├── session-provider.tsx
│   │   │   └── theme-provider.tsx
│   │   ├── settings/
│   │   │   └── notification-delivery-log.tsx
│   │   └── ui/
│   │       ├── index.ts
│   │       ├── alert-tile.tsx
│   │       ├── badge.tsx
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── chart.tsx
│   │       ├── dialog.tsx
│   │       ├── empty-state.tsx
│   │       ├── image-lightbox.tsx
│   │       ├── input.tsx
│   │       ├── label.tsx
│   │       ├── separator.tsx
│   │       ├── skeleton.tsx
│   │       ├── smart-image.tsx
│   │       ├── sortable-th.tsx
│   │       ├── spinner.tsx
│   │       ├── stat-card.tsx
│   │       ├── table-skeleton.tsx
│   │       ├── toaster.tsx
│   │       └── total-products-card.tsx
│   ├── hooks/
│   │   ├── use-alerts.ts
│   │   ├── use-animated-number.ts
│   │   ├── use-camera-scanner.ts
│   │   ├── use-hardware-scanner.ts
│   │   ├── use-modal-focus.ts
│   │   ├── use-popover-menu.ts
│   │   ├── use-resell-from-order.ts
│   │   ├── use-scan-input.ts
│   │   ├── use-stock-sync.ts
│   │   ├── use-table-row-nav.ts
│   │   └── use-unsaved-guard.ts
│   ├── i18n/
│   │   └── locales/
│   │       ├── en.json
│   │       └── ur.json
│   ├── lib/
│   │   ├── alert-utils.ts
│   │   ├── api-auth.ts
│   │   ├── api-error.ts
│   │   ├── api-errors.ts
│   │   ├── api-handler.ts
│   │   ├── audit-log.ts
│   │   ├── auth.ts
│   │   ├── barcode.ts
│   │   ├── cart-math.ts
│   │   ├── checkout-math.ts
│   │   ├── checkout-service.ts
│   │   ├── csv.ts
│   │   ├── currency.ts
│   │   ├── currency-core.ts
│   │   ├── customer-balance.ts
│   │   ├── customer-rollups.ts
│   │   ├── db.ts
│   │   ├── earn-rate.ts
│   │   ├── image-normalize.ts
│   │   ├── inventory-service.ts
│   │   ├── job-status.ts
│   │   ├── low-stock.ts
│   │   ├── low-stock-scheduler.ts
│   │   ├── maintenance.ts
│   │   ├── maintenance-scheduler.ts
│   │   ├── middleware-auth.ts
│   │   ├── money.ts
│   │   ├── notify.ts
│   │   ├── pagination.ts
│   │   ├── payment-math.ts
│   │   ├── print-brand.ts
│   │   ├── print-customer-statement.ts
│   │   ├── print-pos-receipt.ts
│   │   ├── print-purchase-order.ts
│   │   ├── print-receipt.ts
│   │   ├── print-report.ts
│   │   ├── products-bulk.ts
│   │   ├── product-service.ts
│   │   ├── purchase-order-math.ts
│   │   ├── query-date.ts
│   │   ├── rate-limit.ts
│   │   ├── rbac.ts
│   │   ├── receipt-number.ts
│   │   ├── receipt-print.ts
│   │   ├── receipt-snapshot.ts
│   │   ├── refund-math.ts
│   │   ├── refund-service.ts
│   │   ├── report-math.ts
│   │   ├── reservation-cleanup.ts
│   │   ├── reservation-scheduler.ts
│   │   ├── retry.ts
│   │   ├── s3-client.ts
│   │   ├── stock-status.ts
│   │   ├── supplier-stats.ts
│   │   ├── table-sort.ts
│   │   ├── units.ts
│   │   ├── units-intelligence.ts
│   │   ├── uploads.ts
│   │   ├── utils.ts
│   │   ├── verify-consistency.ts
│   │   ├── constants/
│   │   │   └── index.ts
│   │   ├── print/
│   │   │   ├── band-raster.ts
│   │   │   ├── calibration.ts
│   │   │   ├── driver.ts
│   │   │   ├── drivers.ts
│   │   │   ├── escpos.ts
│   │   │   ├── measure.ts
│   │   │   ├── print-intelligence.ts
│   │   │   ├── print-service.ts
│   │   │   ├── receipt-template.ts
│   │   │   └── transport.ts
│   │   └── validations/
│   │       ├── index.ts
│   │       └── print.ts
│   ├── stores/
│   │   ├── index.ts
│   │   ├── cart-store.ts
│   │   ├── notification-store.ts
│   │   ├── palette-recents-store.ts
│   │   ├── settings-store.ts
│   │   ├── toast-store.ts
│   │   ├── ui-store.ts
│   │   └── warehouse-store.ts
│   └── types/
│       ├── index.ts
│       ├── barcode-detector.d.ts
│       └── next-auth.d.ts
├── tests/
│   ├── integration/
│   │   ├── db.ts
│   │   └── env.ts
│   ├── alert-feed.test.ts
│   ├── api-error.test.ts
│   ├── api-errors.test.ts
│   ├── band-raster.test.ts
│   ├── barcode.test.ts
│   ├── cart-math.test.ts
│   ├── checkout-integration.test.ts
│   ├── checkout-tampering.test.ts
│   ├── csv-export.test.ts
│   ├── customer-balance-integration.test.ts
│   ├── customer-rollups.test.ts
│   ├── earn-rate.test.ts
│   ├── escpos.test.ts
│   ├── i18n-keys.test.ts
│   ├── inventory-service-integration.test.ts
│   ├── low-stock.test.ts
│   ├── maintenance.test.ts
│   ├── modal-focus-contract.test.ts
│   ├── money.test.ts
│   ├── pagination.test.ts
│   ├── palette-recents-roaming.test.ts
│   ├── payment-math.test.ts
│   ├── print-brand-sync.test.ts
│   ├── printer-profile-validation.test.ts
│   ├── print-intelligence.test.ts
│   ├── print-service.test.ts
│   ├── print-typography.test.ts
│   ├── products-bulk.test.ts
│   ├── purchase-order-math.test.ts
│   ├── query-date.test.ts
│   ├── rate-limit.test.ts
│   ├── receipt-issue-integration.test.ts
│   ├── receipt-numbering.test.ts
│   ├── receipt-snapshot-hash.test.ts
│   ├── receipt-template.test.ts
│   ├── refund-integration.test.ts
│   ├── refund-math.test.ts
│   ├── report-layout.test.ts
│   ├── report-math.test.ts
│   ├── reprint-permissions.test.ts
│   ├── reservation-cleanup.test.ts
│   ├── retry.test.ts
│   ├── scan-burst.test.ts
│   ├── seed-guard.test.ts
│   ├── stock-status.test.ts
│   ├── ui-consistency.test.ts
│   ├── units-intelligence.test.ts
│   └── uploads.test.ts
└── uploads/
    └── d1893587-5418-4dd7-9609-8bc7aa2b445b.jpg
```

**Collapsed root-level ephemeral items (not expanded above, listed for completeness):**
- 12 loose `audit*.mjs` scripts + 3 loose `.probe-*.mjs` / `.debug-url.mjs` probe scripts
- 20 `.audit-*.log` / `.audit-*.out` / `.dev-server.log` / `.devbuffy.log` / `seed-output.log` / `css-badlines.txt` output files
- 6 hidden scratch dirs: `.audit-baseline/` (16 files), `.audit-shots/` (74 files, 15.4 MB), `.codemod-backup/` (152 files, 5.4 MB), `.dbg-profile/` (742 files, 61.6 MB), `.dbg-profile2/` (902 files, 43.5 MB), `.freebuff/` (1 file)
- Build output dirs: `.next/` (816 MB) and `.next-prod/` (404 MB, 708 files — the isolated prod dist via `NEXT_DIST_DIR`)

---

## 2. Per-top-level-folder stats

| Folder | Files | Approx size | Purpose (one-line guess from contents) |
|---|---|---|---|
| `src/` | 242 | 2.5 MB | All application source: App Router pages, API routes, components, hooks, lib (domain logic + print engine), stores, i18n, types |
| `prisma/` | 9 | 3.0 MB | SQLite database (`dev.db` + 2 manual backups ≈ 2.9 MB), schema, seed script, 3 SQL migrations |
| `tests/` | 50 | 307 KB | Unit + integration test suite (node:test, 495 tests) incl. `tests/integration/` DB/env helpers |
| `scripts/` | 20 | 171 KB | Ops/utility CLIs: migration deploy/status, seeding, audits, codemods, repair/verify scripts |
| `public/` | 19 | 610 KB | Static assets — `fonts/` only: 14 bundled woff2 + 5 OFL license texts |
| `docs/` | 3 | 93 KB | Design/architecture docs (neumorphism system, migrations guide, "golden elite" spec) |
| `samples/` | 7 | 111 KB | Generated print-output samples (sales/inventory/PO HTML in light/dark/Urdu + one xlsx) |
| `uploads/` | 1 | 86 KB | Runtime upload target (one product image) |
| `.github/` | 1 | 5 KB | CI workflow (`workflows/ci.yml`) |
| `.` (root files) | 23 tracked-config + ~35 ephemeral | — | Config (ts/next/eslint/prettier/postcss/package), one task note (`NSM_PRINT_TASK.md`), plus loose audit/probe scripts and their log/out artifacts |

Note: `.next/` (816 MB) and `.next-prod/` (404 MB) are build outputs and excluded per scope; `.dbg-profile*/`, `.audit-shots/`, `.codemod-backup/` are QA/QA-artifact scratch dirs (~126 MB combined) also excluded from expansion.

---

## 3. package.json summary

**name:** `elite-pos` · **version:** `0.1.0` (private)

**Scripts:**

| Script | Command |
|---|---|
| `dev` | `next dev` |
| `build` | `next build` |
| `start` | `next start` |
| `health` | `curl -fsS http://localhost:3000/api/health?probe=live && echo && curl -fsS http://localhost:3000/api/health` |
| `lint` | `next lint` |
| `lint:fix` | `next lint --fix` |
| `typecheck` | `tsc --noEmit` |
| `test` | `tsx --test "tests/*.test.ts"` |
| `db:generate` | `prisma generate` |
| `db:push` | `prisma db push` |
| `db:migrate` | `prisma migrate dev` |
| `db:migrate:create` | `prisma migrate dev --create-only` |
| `db:migrate:deploy` | `tsx scripts/db-migrate-deploy.ts` |
| `db:migrate:status` | `tsx scripts/db-migrate-status.ts` |
| `db:studio` | `prisma studio` |
| `db:seed` | `tsx prisma/seed.ts` |
| `db:seed-demo` | `tsx scripts/seed-demo-sales.ts` |
| `clear:login-attempts` | `tsx scripts/clear-login-attempts.ts` |
| `samples` | `tsx scripts/generate-export-samples.ts` |
| `verify` | `tsx scripts/verify-consistency.ts` |
| `check:dev` | `node scripts/check-dev-server.mjs` |
| `audit:neu` | `node audit-neu-theme.mjs` |
| `audit:neu:pages` | `node audit-neu-pages.mjs` |
| `verify:ui` | `node scripts/verify-ui.mjs` |
| `verify:notifications` | `node scripts/verify-notifications.mjs` |
| `verify:browser` | `node scripts/verify-browser.mjs` |
| `repair:rollups` | `tsx scripts/repair-customer-rollups.ts` |
| `format` | `prettier --write "src/**/*.{ts,tsx,css}"` |
| `format:check` | `prettier --check "src/**/*.{ts,tsx,css}"` |

**Dependencies (35):** `@auth/prisma-adapter` ^2.11.3 · `@fontsource/ibm-plex-sans` ^5.3.0 · `@fontsource/ibm-plex-sans-arabic` ^5.3.0 · `@fontsource/jetbrains-mono` ^5.3.0 · `@fontsource/noto-naskh-arabic` ^5.3.0 · `@fontsource/noto-nastaliq-urdu` ^5.3.0 · `@hookform/resolvers` ^5.9.1 · `@prisma/client` ^6.9.0 · `@radix-ui/react-dialog` ^1.1.14 · `@radix-ui/react-dropdown-menu` ^2.1.14 · `@radix-ui/react-label` ^1.2.7 · `@radix-ui/react-select` ^2.2.5 · `@radix-ui/react-separator` ^1.1.7 · `@radix-ui/react-slot` ^1.2.3 · `@radix-ui/react-tabs` ^1.1.3 · `@radix-ui/react-tooltip` ^1.2.7 · `@types/jsbarcode` ^3.11.4 · `@types/qrcode` ^1.5.6 · `@zxing/browser` ^0.2.1 · `@zxing/library` ^0.21.3 · `bcryptjs` ^3.0.3 · `class-variance-authority` ^0.7.1 · `clsx` ^2.1.1 · `jsbarcode` ^3.12.3 · `lucide-react` ^0.525.0 · `next` ^15.3.5 · `next-auth` ^5.0.0-beta.32 · `nodemailer` ^7.0.13 · `qrcode` ^1.5.4 · `react` ^19.1.0 · `react-dom` ^19.1.0 · `react-hook-form` ^7.87.0 · `tailwind-merge` ^3.3.0 · `zod` ^3.25.67 · `zustand` ^5.0.5

**devDependencies (14):** `@tailwindcss/postcss` ^4.1.11 · `@types/bcryptjs` ^2.4.6 · `@types/node` ^22.15.3 · `@types/nodemailer` ^7.0.12 · `@types/react` ^19.1.4 · `@types/react-dom` ^19.1.5 · `eslint` ^9.28.0 · `eslint-config-next` ^15.3.5 · `postcss` ^8.5.6 · `prettier` ^3.5.3 · `prisma` ^6.9.0 · `tailwindcss` ^4.1.11 · `tsx` ^4.19.4 · `typescript` ^5.8.3

---

## 4. Config inventory

| Config | Present | Key settings |
|---|---|---|
| `tsconfig.json` | ✅ | `baseUrl: "."`; `paths`: `@/* → ./src/*` plus redundant explicit aliases (`@/components`, `@/lib`, `@/stores`, `@/types`, `@/styles`, `@/app`, `@/hooks`, `@/validations → src/lib/validations`, `@/server` — the last two point at dirs that don't exist); `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`; `target ES2017`, `moduleResolution bundler`, `noEmit` (+ contradictory `declaration/declarationMap/sourceMap: true`, inert under noEmit); includes `.next/types` **and** `.next-prod/types` |
| `next.config.ts` | ✅ | `distDir` from `NEXT_DIST_DIR` env (default `.next` — isolated prod builds beside a live dev server); `reactStrictMode`; `poweredByHeader: false`; images allow all https hosts, avif/webp; `removeConsole` in prod; dev `watchOptions.ignored` for profile/audit dirs; security headers (`X-Frame-Options: DENY`, HSTS preload, `Permissions-Policy` camera/usb/serial self) |
| `eslint.config.mjs` | ✅ | Flat config via FlatCompat: `next/core-web-vitals` + `next/typescript`; warn-level `no-console`, `no-unused-vars` (TS-owned), `no-explicit-any`; **two custom local rules** (`@local/require-dialog-body`, `@local/no-dialog-footer-div`) defined inline; ignores `node_modules/ .next/ dist/ prisma/` |
| Prettier | ✅ `.prettierrc` | printWidth 100, tabWidth 2, double quotes, semi, es5 trailing commas, LF; CSS override (double quotes) |
| `tailwind.config.*` | ❌ absent | Tailwind v4 via `@tailwindcss/postcss` (CSS-first config; theme tokens live in `src/app/globals.css`) |
| `postcss.config.mjs` | ✅ | Single plugin: `@tailwindcss/postcss` |
| `.editorconfig` | ❌ absent | — |
| `.env.example` | ✅ | Exists at root (contents not reported — env file) |
| Other | — | `next-env.d.ts` (generated; **gitignored** — machine-written, content depends on active distDir, CI runs `next typegen` before typecheck); `tsconfig.tsbuildinfo` (build artifact, present at root); `package-lock.json` (name only per scope) |

---

## 5. Naming/placement anomalies (flagged, not fixed)

**Near-identical names / purpose in different locations**
- `src/lib/print-receipt.ts` vs `src/lib/print/print-service.ts` vs `src/lib/print/receipt-template.ts` vs `src/lib/receipt-print.ts` vs `src/lib/print-pos-receipt.ts` — five receipt-printing names across two folders (`lib/` root and `lib/print/`); the `print-receipt` / `receipt-print` transposed pair sits in the same folder.
- `src/lib/api-error.ts` vs `src/lib/api-errors.ts` — singular/plural pair in the same folder (parser vs producer, but indistinguishable by name).
- `src/lib/currency.ts` vs `src/lib/currency-core.ts` — same-folder split with no naming signal for which is the entry point.
- `src/lib/verify-consistency.ts` vs `scripts/verify-consistency.ts` — same basename, intentional core/wrapper split, but identical names.
- `src/lib/driver.ts`-style pairs inside `src/lib/print/`: `driver.ts` vs `drivers.ts` (singular/plural).
- `src/lib/units.ts` vs `src/lib/units-intelligence.ts`, `src/lib/low-stock.ts` vs `low-stock-scheduler.ts`, `maintenance.ts` vs `maintenance-scheduler.ts`, `reservation-cleanup.ts` vs `reservation-scheduler.ts` — paired base/+variant names, consistent but easy to confuse.
- `src/lib/api-handler.ts` present alongside `api-auth.ts`/`api-errors.ts` — three api-* modules with no folder.
- `src/app/api/seed/seed-runner.ts` — the only non-`route.ts` file inside `app/api/` (logic colocated with routes; all other lib lives in `src/lib`).
- `audit-neu-theme.mjs` / `audit-neu-pages.mjs` at repo root vs `scripts/verify-ui.mjs` etc. in `scripts/` — two generations of the same audit idea in two places.

**Loose files at a root that look like they belong in a subfolder**
- 12 `audit*.mjs` scripts + `.probe-refund.mjs`, `.probe-refund2.mjs`, `.debug-url.mjs` at repo root — sibling `scripts/` exists and holds similar tooling (also `scripts/audit-harness.mjs`, suggesting the loose ones predate it).
- 20+ audit/dev log & `.out` artifacts (`.audit-*.log`, `.audit-*.out`, `.dev-server.log`, `.devbuffy.log`, `seed-output.log`, `css-badlines.txt`) at repo root — no artifacts/logs dir.
- `.audit-baseline/`, `.audit-shots/`, `.dbg-profile/`, `.dbg-profile2/`, `.codemod-backup/` scratch dirs at repo root (referenced by `next.config.ts` watch ignores, but ~126 MB of browser profiles/screenshots in-tree).
- `NSM_PRINT_TASK.md` at repo root — lone task note; `docs/` exists.
- `tsconfig.tsbuildinfo` at repo root — build artifact inside the source tree.
- `prisma/dev.db.backup-20260918` and `prisma/dev.db.bak-before-runninglow` — two ad-hoc DB snapshots with different backup-naming conventions in the schema folder.
- `uploads/d1893587-….jpg` — runtime user upload checked into the tree root of `uploads/`.

**Casing / pattern mismatches among siblings**
- `src/app/icon.svg` — fine, but the only non-ts/tsx asset inside `src/app`.
- `src/types/barcode-detector.d.ts` and `next-auth.d.ts` are `.d.ts` ambient declarations mixed with `index.ts` in `src/types/` (conventional, but mixed file kinds).
- Tests are uniformly kebab-case `*.test.ts`; hooks/stores/components kebab-case; pages are route-driven `page.tsx` — casing itself is consistent; the standout is the root where kebab-case `audit-*.mjs` mixes with the dot-prefixed `.audit-*.log` outputs of the same family.
- `scripts/` mixes `.ts` and `.mjs` (~11 ts / 9 mjs) with no convention split (ts = needs Prisma/DOM? mjs = browser/pure node).
