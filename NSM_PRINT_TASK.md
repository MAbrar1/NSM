# NSM PRINT · RECEIPT · SCAN SUBSYSTEM — TWO-PHASE TASK

## 0. ROLE, SCOPE, RULES
Senior full-stack engineer in an EXISTING repo: NSM (Najjar Super Mart) offline-first retail POS/ERP. Expected, but verify: Tauri desktop, Fastify backend, pnpm monorepo, PKR ledger in bigint paisa, English/Urdu, FBR compliance, a domain-core/SSOT package for money. Not greenfield. Discover structure, paths, libraries and conventions from the repo; open a file before citing it.
IN SCOPE: (1) receipt generation, storage references, reprint, print log; (2) thermal printing 58/80/112 mm and custom widths (e.g. 88 mm); (3) A4/A5 report printing, PDF/CSV export; (4) barcode input; (5) sale→receipt and purchase→inventory flows only where they touch 1–4. Everything else: do not modify; read only to understand a dependency.
These rules bind every sub-agent you spawn; pass them verbatim when delegating. Never read or print .env files, keys, or production DB files.

## 1. PHASE GATE
- Phase 1 is read-only: no create/edit/rename/delete, no install, build, codegen or migration. Read-only commands only (ls, grep, git status/log, package listing).
- Phase 2 starts only when the user replies exactly "APPROVED". Any other reply means: revise the Phase 1 report and stop.
- Before Phase 2: create a new git branch; if the working tree is dirty, stop and ask.

## 2. PHASE 1 — VERIFY (evidence = path:line-range, or "NOT FOUND" after searching; never guess)
A. Repo map: workspaces, entry points, runtimes, package manager, test/lint/type-check commands, DB engine + migration tool, sync engine (multi-terminal offline), Tauri version + capability/permission config, existing schema-validation library, browser/e2e test tooling, lockfiles (JS and Cargo).
B. Data flow, each EXISTS/PARTIAL/MISSING: category, supplier, product (barcodes, units, tax class, reorder level), purchase order, GRN, supplier invoice/payment, stock movements, inventory views (on-hand, low stock, expiry, valuation), sales order+items (price/tax/cost snapshots), payments (split, credit), customer (walk-in/named), shift open/close, returns/refunds/voids, ledger (hash-chained).
C. Receipts: table, number series (per terminal? gap-free? allocated inside the sale transaction? existing numbers to continue), print log, template + versioning (are old versions still renderable?), FBR fields and how offline-then-synced fiscalization is stored, duplicate marking, reprint permission checks, what the sale snapshot freezes (cashier, terminal, loyalty balance…), current render/print path, fixed vs content-driven length.
D. Printing: libraries, Tauri commands/sidecars, ESC/POS code, window.print usage, printer settings storage, Urdu handling, feed/cut, DOM→bitmap method, available transports (USB/serial/TCP/spooler; Rust crates), Linux/WebKit print support.
E. Scanning: scan hook, keyboard-wedge handling, camera, barcode lookup, multi-barcode products, pack/unit barcodes, embedded weight/price barcodes, unique-barcode constraint, behaviour under Urdu keyboard layout.
F. Reports: screens, shared layout, print CSS (@page, breaks), export formats, embedded Urdu font, PDF generation path.
G. SSOT violations in scope: duplicated templates or money/format helpers, stored derived totals/balances, inline arithmetic outside services.
H. Risks and conflicts with Phase 2.
Before answering, confirm every table row cites a file you opened.

### Phase 1 output (exact structure, nothing else)
1. Repository Map
2. Verification Table (Item | EXISTS/PARTIAL/MISSING | Evidence | Notes)
3. Gaps vs Target
4. Reuse Plan (extend, not replace)
5. Proposed Change List (every file to create/edit, one-line reason, ordered, grouped by milestone M1–M6)
6. Open Questions (max 5, blocking only)
Last line: "Awaiting APPROVED to begin Phase 2."

## 3. PHASE 2 — IMPLEMENT (extend what Phase 1 found; add only what is missing or broken)
Milestones: M1 data+profiles+numbering · M2 render pipeline · M3 PrintService+drivers+Tauri commands · M4 reprint/permissions/lookups/settings UI/calibration · M5 reports/export · M6 scanning.
After each milestone: run the repo's own type-check, lint and tests; show real output; git commit; give a 3-line status; continue. If the same failure repeats 3 times, stop and report. Re-read this file at the start of each milestone.

### 3.1 PrintService
One `PrintService`, one driver interface. Drivers: `EscPosRasterDriver` (primary thermal), `EscPosTextDriver` (optional, English-only), `BrowserPrintDriver` (reports, PWA fallback), `PdfDriver` (share/email/archive). No screen, component or route calls a printer or window.print directly. Tauri: build ESC/POS bytes in frontend or Rust; hardware access only inside scoped Tauri commands. PWA: Chrome kiosk printing by default; the interface must allow a local agent or WebUSB/Web Serial driver later without touching callers. Per-printer serialized queue, timeouts, typed errors (OFFLINE, TIMEOUT, TRANSPORT, PAPER_OUT if detectable). Printing never re-runs a sale; failure leaves the committed sale intact and offers Retry from the saved record.

### 3.2 Variable-length thermal receipts (CRITICAL)
Paper is a continuous roll: exactly as long as the content — no fixed/guessed height, no page breaks, no blank tail.
1. Render the single template off-screen: width = profile `printable_dots` CSS px, DPR 1, no scaling, height auto, minimal fixed bottom padding.
2. Before measuring: `document.fonts.load()` for every family/weight with the real text (Urdu included), then `document.fonts.ready`, `img.decode()`, two animation frames. Height = ceil(getBoundingClientRect().height). Nastaliq ascenders/descenders must not clip (test it).
3. Never allocate one canvas of full height (webview canvas limits, ~16k px, break 500-line receipts). Rasterize band by band from the same DOM: each band canvas ≤ `band_height` (default 256), offset-translated. Convert to 1-bit (threshold for text; dithering optional for images). QR/barcode at integer module scale, no smoothing. QR physical size and FBR logo come from the existing FBR config (published FBR specs differ by regime, e.g. 7×7 mm vs 1×1 in) — never hardcode; ask if absent.
4. Emit ESC/POS raster per band (`GS v 0`; profile `raster_command` allows a fallback), rows byte-aligned, no inter-band gap; a per-profile gap-compensation setting; the calibration print tests it.
5. After the last band: feed `feed_before_cut_lines` (default 3–4), cut per `cut_mode`, kick the drawer only if enabled.
6. 1 to ≥500 items, no cap; long names wrap and lengthen the receipt.
7. Preview = same template, same measurement, scrollable. Text driver: same feed/cut. Browser driver: `@page { size: <w>mm auto; margin: 0 }`, no breaks; document in code and Settings that browsers vary on auto-length rolls — the raster path is authoritative.
8. Reports never use auto-length (see 3.6).

### 3.3 Single receipt template (SSOT)
One HTML/CSS template drives preview, thermal image and PDF. Urdu reaches thermal printers as raster only. Bundle an Urdu font locally (Noto Nastaliq Urdu or Naskh Arabic; check licence); never load fonts from the network. English, Urdu, bilingual (RTL-correct); logo, QR, barcode areas. Content: store name/logo/address, NTN/STRN, receipt no, date/time (stored UTC, shown in store timezone), cashier, terminal, customer, lines (name, qty, unit price, discount, total), subtotal, discount, tax breakdown, grand total, payments/change, loyalty earned/balance (frozen at sale), FBR invoice no + logo + QR + verification statement (or "pending fiscalization" offline), return policy, footer. Amounts come from the frozen snapshot via existing money helpers (bigint paisa); no arithmetic in the template.

### 3.4 Printer profiles (no hardcoded widths)
Entity + Settings screen. Fields: name, connection type/target, paper_width_mm, printable_dots, dpi, chars_per_line, codepage, raster_command, band_height, inter-band gap fix, feed_before_cut_lines, cut_mode, drawer_kick (on/off + pulse pin), default_for (receipt/report/label), enabled. Presets 58 mm/384, 80 mm/576, 112 mm/832 dots, all editable; custom widths (88 mm) by editing a profile, never code. Validate with the project's schema library (printable_dots multiple of 8 and consistent with width×dpi). Calibration print: width ruler, text block, Urdu sample, QR, barcode, logo, 50-line section (band seams + auto-length), feed, cut, drawer if enabled.

### 3.5 Receipt storage, reprint, audit
- Source of truth = immutable sale snapshot + `template_version`. Never store rendered copies. Every template version stays renderable; a layout change creates a new version.
- `receipts`: receipt_no (unique, per-terminal series, gap-free, no reuse, allocated inside the sale transaction, continuing existing numbers), order_id, issued_at, template_version, language, content_hash. Voided sales keep their number with VOID status.
- `content_hash` = SHA-256 of canonical snapshot + template_version; excludes the reprint marker and fiscal fields; verified before every reprint (mismatch → block + audit entry).
- FBR data may arrive after issue: keep it in an append-only fiscal record (invoice_no, qr_payload, fiscalized_at); the receipts row never changes; reprints show the latest fiscal data.
- `receipt_print_log`, append-only and DB-enforced (no UPDATE/DELETE): receipt_id, action (PRINT, REPRINT, EMAIL, WHATSAPP, PDF), result (OK/FAILED), error_code, user, terminal, printer_profile, timestamp, reason. A retry of a failed first print stays PRINT; only after a success is any further print a REPRINT.
- REPRINT: "DUPLICATE COPY" + count; existing RBAC (cashier: own recent-shift receipts; manager: any; window configurable; reason required); always logs.
- Corrections only via Return/Credit Note.
- Lookups: Sales History (receipt no, date, customer, cashier, amount), customer history, Returns-by-receipt-number, last receipts of the current shift.
- New tables join the existing sync engine (log rows merge as a union). Migrations are additive and reversible, tested on a DB copy.

### 3.6 Reports and exports
One `ReportLayout`: header, applied filters, repeated table header on every page (`thead { display: table-header-group }`), `break-inside: avoid` rows, footer page numbers (verify @page margin-box support in the target webviews; otherwise fall back), A4/A5 `@page`, RTL/Urdu with the local font. Print via BrowserPrintDriver. "Save as PDF" and CSV/Excel come from the same report query (never one query per format). PDF: in Tauri, browser print is not programmatic and WebKitGTK printing is limited — choose the PDF path from Phase 1 evidence and prove Urdu shaping in the output before adopting a library. CSV: UTF-8 BOM, amounts as decimal strings derived from paisa, neutralise formula injection (cells starting = + - @). All figures come from service/DB-view derivations.

### 3.7 Barcode scanning
One global scan hook. Keyboard-wedge detection: buffered burst with tiny inter-key gaps ending in Enter/Tab; configurable gap threshold, min length, prefix/suffix (Settings). Must work under an Urdu keyboard layout (`event.code` fallback; test it). If a burst starts inside an editable field, remove the leaked characters. Route by focused context; a scan never types into an unrelated input; debounce double scans. One `ProductService.findByBarcode`: multiple barcodes per product, pack/unit barcodes, embedded weight/price barcodes (prefix, item-code length, value length, decimals and value type configured in Settings; integer parsing; GS1 check digit validated). Unknown barcode → error sound + quick-create prompt. Camera optional: native `BarcodeDetector` with a maintained fallback (e.g. @zxing/browser) behind the same interface.

### 3.8 Flow rules
Category before product. Only a GRN increases stock. The sale commit is ONE atomic transaction: order + items (price/tax/cost snapshots) + stock movements + ledger entries + receipt number; any failure rolls back everything. Credit sales require a named customer (walk-in is the default). No financial record is edited or deleted — void, return or reversal only.

## 4. HARD CONSTRAINTS
- Invent nothing: no tables, columns, routes, packages, paths or business rules. Not found = "NOT FOUND".
- Thermal: no fixed/guessed height, no forced page breaks, no window.print as primary path, no Urdu as text. No hardcoded widths, dots, printer names, ports, band heights or feed lengths.
- One PrintService, one receipt template, one money formatter, one scan handler, one ReportLayout. Reuse and extend.
- No floating-point money; no arithmetic outside the money/service layer; no stored derived totals; zero `any`.
- Preserve FBR, tax, Zakat, RBAC, audit-log and hash-chained-ledger logic.
- New dependency: check both lockfiles for an equivalent first; state name, purpose, licence and maintenance status; prefer a Tauri/Rust command over a native Node module.
- Change only files in the approved list (plus new tests for code you add); anything else → stop and ask. Renaming/removing/changing the signature of an exported function needs a "Breaking Change Warning" and approval. No unrelated cleanup. Never modify or delete existing tests to make them pass.
- Never claim a test, build or print succeeded unless you ran it and saw the output. State when hardware is unavailable.

## 5. PHASE 2 SELF-VERIFICATION
Report real output of type-check, lint and tests, then confirm:
1. Exactly one PrintService, receipt template, scan hook, ReportLayout.
2. Measured heights for 1, 10, 100, 500 items grow proportionally; the bitmap has no blank tail beyond feed_before_cut_lines.
3. A test decodes the emitted ESC/POS stream back to a bitmap and asserts equality with the source (no seams); golden-byte tests for init, raster header, feed, cut, kick. Band size and feed values come from the profile.
4. 58/80/112 mm presets and a custom 88 mm profile work by configuration only.
5. Reprint renders from snapshot + template_version; hash identical (also after a fiscal update); DUPLICATE COPY shown; log row written.
6. Urdu renders in the raster preview with the bundled font.
7. A print failure leaves the sale untouched; Retry reprints from the record.
8. Sale atomicity, stock deduction and ledger entries are unchanged or test-covered.
9. Tests exist for: height measurement + band splitting; scan-burst (incl. leaked-character removal, Urdu layout); barcode resolution (multi/pack/embedded/check digit); profile validation; receipt numbering (no gaps/collisions across terminals); reprint permissions; hash stability; print-log immutability.
10. Every changed file is in the approved list with a one-line reason.
State plainly what could NOT be verified (e.g. physical printer output, real-webview canvas limits).

## 6. OUTPUT SPEC
Phase 1: exactly the structure in §2, then stop.
Phase 2 final report only:
(a) Summary: reused vs added
(b) Files changed: path + purpose, plus `git diff --stat`
(c) Dependencies added (or "none")
(d) Code lives on disk in the branch; print full code for a file only if the user asks "SHOW CODE <file>"
(e) Verification report: real outputs + checklist
(f) Not verified + manual physical-printer steps using the long-receipt sample