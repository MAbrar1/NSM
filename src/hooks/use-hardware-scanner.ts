"use client";

import * as React from "react";
import { normalizeScannedCode } from "@/lib/barcode";

/* ═══════════════════════════════════════════════════════════════
   USE-HARDWARE-SCANNER — global USB/Bluetooth scanner-wedge listener.

   Hardware scanners emulate a keyboard: they type the code in a fast
   burst (<30 ms between keystrokes) and finish with Enter. This hook
   captures that burst anywhere on the page (no input focus needed),
   intercepting the Enter in the CAPTURE phase so it beats input
   handlers, and resolves the scan through the provided callback.

   Human typing can never trigger it: a real person pauses between
   keystrokes (>30 ms resets the buffer) and rarely produces a 4+
   character burst ending in Enter while still "warm".

   Used by the POS (auto add-to-cart) and can be dropped into any
   page that wants scan-to-search / scan-to-filter behavior.
   ═══════════════════════════════════════════════════════════════ */

interface UseHardwareScannerOptions {
  /** Called with the normalized code when a scan burst completes. */
  onScan: (code: string) => void;
  /** Disable the listener (e.g. while a modal is open). Default true. */
  enabled?: boolean;
  /** Max ms between keystrokes before the buffer resets. Default 30. */
  maxGapMs?: number;
  /** Min burst length to count as a scan. Default 4. */
  minLength?: number;
}

export function useHardwareScanner({
  onScan,
  enabled = true,
  maxGapMs = 30,
  minLength = 4,
}: UseHardwareScannerOptions): void {
  const onScanRef = React.useRef(onScan);
  React.useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const enabledRef = React.useRef(enabled);
  React.useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const optsRef = React.useRef({ maxGapMs, minLength });
  optsRef.current = { maxGapMs, minLength };

  React.useEffect(() => {
    if (!enabledRef.current) return;

    const buffer = { text: "", lastAt: 0 };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;

      if (e.key === "Enter") {
        const warm = buffer.lastAt > 0 && Date.now() - buffer.lastAt < 1000;
        if (buffer.text.length >= optsRef.current.minLength && warm) {
          e.preventDefault();
          e.stopPropagation();
          const value = buffer.text;
          buffer.text = "";
          buffer.lastAt = 0;
          const code = normalizeScannedCode(value);
          if (code) onScanRef.current(code);
        }
        return;
      }

      if (e.key.length === 1) {
        const now = Date.now();
        if (now - buffer.lastAt > optsRef.current.maxGapMs) buffer.text = "";
        buffer.text += e.key;
        buffer.lastAt = now;
      }
    };

    // Capture phase → runs before React's delegated handlers at the root,
    // so the terminating Enter never reaches the focused input.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
