import { z } from "zod";

/* ═══════════════════════════════════════════════════════════════
   PRINT / RECEIPT VALIDATION SCHEMAS
   Printer profiles validate with the project's schema library
   (zod). Every thermal number is data on the profile — these rules
   only reject physically impossible combinations, never a width:
   58 mm, 80 mm, 112 mm and custom 88 mm all pass by configuration.
   ═══════════════════════════════════════════════════════════════ */

/**
 * printable_dots must be a multiple of 8 (ESC/POS raster rows are
 * byte-aligned) and consistent with the paper width × dpi
 * (±15% tolerance so head widths that trim margins still validate).
 */
export const printerProfileSchema = z
  .object({
    name: z.string().min(1).max(80),
    connectionType: z.enum(["webusb", "webserial", "browser", "text"]).default("browser"),
    connectionTarget: z.string().max(200).optional().nullable(),
    paperWidthMm: z.number().positive().max(200),
    printableDots: z.number().int().min(8).max(4096),
    dpi: z.number().int().min(60).max(600).default(203),
    charsPerLine: z.number().int().min(16).max(200).default(42),
    codepage: z.string().min(2).max(20).default("cp437"),
    rasterCommand: z.enum(["gs_v0", "gs_l"]).default("gs_v0"),
    bandHeight: z.number().int().min(8).max(1024).default(256),
    interBandGapFix: z.number().int().min(0).max(64).default(0),
    feedBeforeCutLines: z.number().int().min(0).max(64).default(3),
    cutMode: z.enum(["full", "partial", "none"]).default("full"),
    drawerKick: z.boolean().default(false),
    drawerPin: z.union([z.literal(2), z.literal(5)]).default(2),
    defaultFor: z.enum(["receipt", "report", "label"]).optional().nullable(),
    isEnabled: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    if (p.printableDots % 8 !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["printableDots"],
        message: "printableDots must be a multiple of 8 (byte-aligned raster rows)",
      });
    }
    // printableDots ≤ physical width (plus small tolerance) — a head can
    // be NARROWER than the paper (58 mm rolls have ~48 mm printable
    // heads: 384 dots @ 203 dpi), but never wider. A ≥60% floor rejects
    // nonsense combinations while accepting every real head.
    const physicalDots = (p.paperWidthMm / 25.4) * p.dpi;
    if (p.printableDots > physicalDots * 1.15 || p.printableDots < physicalDots * 0.6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["printableDots"],
        message: `printableDots inconsistent with paperWidthMm×dpi (physical ≈ ${Math.round(physicalDots)} dots for ${p.paperWidthMm}mm @ ${p.dpi}dpi; heads may be narrower, not wider)`,
      });
    }
    if (p.bandHeight % 8 !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bandHeight"],
        message: "bandHeight must be a multiple of 8",
      });
    }
  });

export type PrinterProfileInput = z.infer<typeof printerProfileSchema>;

/** Presets: seeded, editable rows — never constants in code. */
export const PRINTER_PRESETS: Array<
  Pick<
    PrinterProfileInput,
    "name" | "paperWidthMm" | "printableDots" | "dpi" | "charsPerLine"
  >
> = [
  { name: "58 mm thermal", paperWidthMm: 58, printableDots: 384, dpi: 203, charsPerLine: 32 },
  { name: "80 mm thermal", paperWidthMm: 80, printableDots: 576, dpi: 203, charsPerLine: 48 },
  { name: "112 mm thermal", paperWidthMm: 112, printableDots: 832, dpi: 203, charsPerLine: 64 },
];

/* ─── Scan settings (keyboard wedge) ───────────────────────────── */

export const scanSettingsSchema = z.object({
  maxGapMs: z.number().int().min(5).max(500).default(30),
  minLength: z.number().int().min(2).max(50).default(4),
  terminatingKey: z.enum(["Enter", "Tab"]).default("Enter"),
  prefix: z.string().max(10).optional().or(z.literal("")),
  suffix: z.string().max(10).optional().or(z.literal("")),
  debounceMs: z.number().int().min(0).max(5000).default(300),
  useEventCode: z.boolean().default(true),
  stripLeakedChars: z.boolean().default(true),
});

export type ScanSettingsInput = z.infer<typeof scanSettingsSchema>;

/* ─── Receipt language ─────────────────────────────────────────── */

export const receiptLanguageSchema = z.enum(["en", "ur", "bilingual"]);
export type ReceiptLanguage = z.infer<typeof receiptLanguageSchema>;
