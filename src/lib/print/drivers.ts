/* ═══════════════════════════════════════════════════════════════
   PRINT DRIVERS
   Four implementations of the one driver interface:

   - EscPosRasterDriver (PRIMARY thermal): sends the built ESC/POS
     byte stream through a byte transport. Urdu arrives as raster —
     by design this driver never sends Urdu text bytes.
   - EscPosTextDriver (optional, English-only): codepage text + the
     same feed/cut contract. Fallback for dot-matrix style heads.
   - BrowserPrintDriver (reports / PWA fallback): opens the document
     in a hidden iframe and calls print() there — the one sanctioned
     window.print inside the codebase, reachable ONLY via the
     PrintService.
   - PdfDriver: hands PDF bytes to a download/share (archive path);
     the PDF *generation* path lives in report-layout/pdf pipeline.
   ═══════════════════════════════════════════════════════════════ */

import { PrintDriver, PrintError, PrintJob, DriverProfile } from "./driver";
import { resolveTransport } from "./transport";

/** The profile fields the raster driver uses (plus transport type). */
type RasterProfile = DriverProfile;

export class EscPosRasterDriver implements PrintDriver {
  readonly kind = "escpos-raster" as const;
  readonly name = "ESC/POS raster";

  async print(job: PrintJob, profile: RasterProfile, signal?: AbortSignal): Promise<void> {
    if (job.kind !== this.kind || !job.bytes) {
      throw new PrintError("UNSUPPORTED", "Raster driver needs an escpos-raster job with bytes");
    }
    const transport = resolveTransport(profile.connectionType);
    await transport.write(job.bytes, profile.connectionTarget, signal);
  }

  async isAvailable(profile: RasterProfile): Promise<boolean> {
    try {
      const transport = resolveTransport(profile.connectionType);
      return await transport.available(profile.connectionTarget);
    } catch {
      return false;
    }
  }
}

export class EscPosTextDriver implements PrintDriver {
  readonly kind = "escpos-text" as const;
  readonly name = "ESC/POS text";

  async print(job: PrintJob, profile: DriverProfile, signal?: AbortSignal): Promise<void> {
    if (job.kind !== this.kind || !job.bytes) {
      throw new PrintError("UNSUPPORTED", "Text driver needs an escpos-text job with bytes");
    }
    const transport = resolveTransport(profile.connectionType);
    await transport.write(job.bytes, profile.connectionTarget, signal);
    void profile;
    void signal;
  }

  async isAvailable(profile: DriverProfile): Promise<boolean> {
    try {
      const transport = resolveTransport(profile.connectionType);
      return await transport.available(profile.connectionTarget);
    } catch {
      return false;
    }
  }
}

export class BrowserPrintDriver implements PrintDriver {
  readonly kind = "browser-html" as const;
  readonly name = "Browser print";

  async print(job: PrintJob, _profile: DriverProfile, signal?: AbortSignal): Promise<void> {
    if (job.kind !== this.kind || !job.html) {
      throw new PrintError("UNSUPPORTED", "Browser driver needs a browser-html job with html");
    }
    if (typeof document === "undefined") {
      throw new PrintError("UNSUPPORTED", "Browser print requires a DOM");
    }
    if (signal?.aborted) throw new PrintError("CANCELLED", "Job aborted before print");

    // Hidden iframe print: no popup blockers, same-origin document,
    // fonts resolve from the app origin (local Urdu font).
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;";
    const ready = new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new PrintError("TRANSPORT", "Print frame failed to load"));
    });
    document.body.appendChild(frame);
    try {
      const doc = frame.contentDocument;
      if (!doc) throw new PrintError("TRANSPORT", "Print frame document unavailable");
      doc.open();
      doc.write(job.html);
      doc.close();
      await ready;
      // Give layout/fonts one frame; the document embeds its own
      // @font-face and print CSS.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch (err) {
      if (err instanceof PrintError) throw err;
      throw new PrintError("TRANSPORT", `Browser print failed: ${(err as Error).message}`, err);
    } finally {
      // Cleanup after a generous delay — Chromium needs the frame alive
      // while the print dialog is up.
      setTimeout(() => frame.remove(), 60_000);
    }
  }

  async isAvailable(): Promise<boolean> {
    return typeof document !== "undefined";
  }
}

export class PdfDriver implements PrintDriver {
  readonly kind = "pdf" as const;
  readonly name = "PDF";

  async print(job: PrintJob, _profile: DriverProfile): Promise<void> {
    if (job.kind !== this.kind || !job.pdf) {
      throw new PrintError("UNSUPPORTED", "PDF driver needs a pdf job with pdf bytes");
    }
    if (typeof document === "undefined") {
      throw new PrintError("UNSUPPORTED", "PDF download requires a DOM");
    }
    const blob = new Blob([job.pdf as unknown as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = job.filename ?? "document.pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async isAvailable(): Promise<boolean> {
    return typeof document !== "undefined";
  }
}
