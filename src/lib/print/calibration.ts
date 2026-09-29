/* ═══════════════════════════════════════════════════════════════
   CALIBRATION PRINT
   One diagnostic page per printer profile that proves the physical
   pipeline: width ruler (are dots mapped to the real paper width?),
   text block, Urdu sample (Nastaliq ascenders/descenders), QR and
   barcode (integer module scale), a 50-line section (band seams +
   auto-length behavior), then the profile's feed + cut (+ drawer
   kick when enabled). Every dimension comes from the profile — the
   page is identical for 58, 80, 112 mm or a custom 88 mm printer.
   ═══════════════════════════════════════════════════════════════ */

import { URDU_FONT_FAMILY } from "./receipt-template";

export interface CalibrationProfile {
  name: string;
  printableDots: number;
  dpi: number;
  bandHeight: number;
  feedBeforeCutLines: number;
  cutMode: "full" | "partial" | "none";
  drawerKick: boolean;
}

/**
 * Build the calibration document HTML at the profile's width.
 * Rendered through the same measurement + raster pipeline as a
 * receipt, so what this page shows is what receipts will do.
 */
export function buildCalibrationHtml(profile: CalibrationProfile): string {
  const widthPx = Math.round((profile.printableDots / profile.dpi) * 96);
  const ruler = buildRuler(profile);
  const fifty = Array.from({ length: 50 }, (_, i) => `<div class="ln">${String(i + 1).padStart(3, "0")} · band-seam sample · 0123456789</div>`).join("");

  return `<!DOCTYPE html>
<html dir="ltr">
<head>
<meta charset="utf-8" />
<title>Calibration — ${profile.name}</title>
<style>
  @font-face {
    font-family: "${URDU_FONT_FAMILY}";
    src: url("/fonts/noto-nastaliq-urdu-arabic-400-normal.woff2") format("woff2");
    font-weight: 400;
    font-display: block;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 12px; color: #000; background: #fff; }
  .page { width: ${widthPx}px; padding: 4px 2px 6px; }
  h1 { font-size: 14px; text-align: center; }
  .sec { border-top: 1px dashed #000; padding: 6px 0; }
  .label { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: #444; }
  .ruler { position: relative; height: 26px; border-bottom: 2px solid #000; }
  .ruler span { position: absolute; bottom: 0; border-left: 1px solid #000; height: 8px; font-size: 7px; padding-left: 1px; }
  .ruler span.half { height: 14px; }
  .urdu { font-family: "${URDU_FONT_FAMILY}", sans-serif; font-size: 14px; line-height: 2; text-align: right; direction: rtl; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  .qrbox, .barbox { display: flex; gap: 12px; align-items: center; }
  .fifty .ln { font-size: 11px; white-space: nowrap; overflow: hidden; }
  .fine { font-size: 9px; color: #333; }
  @media print { @page { size: ${widthPx}px auto; margin: 0; } }
</style>
</head>
<body>
<div class="page">
  <h1>CALIBRATION · ${profile.name}</h1>

  <div class="sec">
    <div class="label">Width ruler — ${profile.printableDots} dots @ ${profile.dpi} dpi (${widthPx}px)</div>
    ${ruler}
  </div>

  <div class="sec">
    <div class="label">Text block</div>
    <div>ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwx 0123456789 !@#$%^&amp;*() طھظ</div>
    <div class="mono">Monospace: |..|..|..| aligns columns 12345678.90</div>
  </div>

  <div class="sec">
    <div class="label">Urdu sample (Nastaliq — check clipping)</div>
    <div class="urdu">نئیجار سپر مارٹ · رسید نمبر R-T1-000001 · کل رقم Rs 1,234.56 · ادائیگی نقد — بلند و بازو حروف کی جانچ</div>
  </div>

  <div class="sec">
    <div class="label">QR (integer module scale) + barcode</div>
    <div class="qrbox">
      <div data-qr-payload="NSM-CAL-${profile.printableDots}" class="qr"></div>
      <div class="fine">QR payload: NSM-CAL-${profile.printableDots}<br/>must scan crisp, no smoothing</div>
    </div>
    <div class="barbox">
      <div data-barcode="4006381333931" class="bar"></div>
      <div class="fine">EAN-13 4006381333931</div>
    </div>
  </div>

  <div class="sec fifty">
    <div class="label">50-line section — band seams (${profile.bandHeight}-dot bands) + length growth</div>
    ${fifty}
  </div>

  <div class="sec fine">
    Profile: feed ${profile.feedBeforeCutLines} lines before cut · cut ${profile.cutMode} · drawer kick ${profile.drawerKick ? "ON" : "off"}.<br/>
    Verify: no blank tail before the feed, no seams in the 50-line block, ruler ends at the paper edge.
  </div>
</div>
</body>
</html>`;
}

/** A mm ruler across the printable width, half-cm ticks taller. */
function buildRuler(profile: CalibrationProfile): string {
  const widthMm = (profile.printableDots / profile.dpi) * 25.4;
  const widthPx = Math.round((profile.printableDots / profile.dpi) * 96);
  const ticks: string[] = [];
  const pxPerMm = widthPx / widthMm;
  for (let mm = 0; mm <= Math.floor(widthMm); mm++) {
    const half = mm % 5 === 0;
    ticks.push(`<span class="${half ? "half" : ""}" style="left:${(mm * pxPerMm).toFixed(1)}px">${half ? mm : ""}</span>`);
  }
  return `<div class="ruler">${ticks.join("")}</div>`;
}
