"use client";

import * as React from "react";

/* ═══════════════════════════════════════════════════════════════
   USE-SCAN-INPUT — the ONE global scan handler.
   Supersedes the per-page useHardwareScanner with:

   - configurable thresholds (gap, min length, terminator, prefix/
     suffix) from ScanSettings — slow Bluetooth scanners are a
     settings change, not a code change
   - event.code fallback: under an Urdu (or any non-QWERTY) keyboard
     layout, scanners still emit physical QWERTY key positions, so
     KeyA..KeyZ/ Digit0..9 map back to the layout-independent code —
     the wedge works no matter which input language is active
   - leaked-character removal: if a burst starts inside an editable
     field, the chars the scanner already typed there are removed
   - debounce: a duplicate scan within the window is suppressed
   - context routing: onScan receives the code; the focused page
     decides what it means — a scan never types into an unrelated
     input (capture-phase Enter interception, like the legacy hook)
   ═══════════════════════════════════════════════════════════════ */

import type { ScanSettingsInput } from "@/lib/validations/print";

export const DEFAULT_SCAN_SETTINGS: ScanSettingsInput = {
  maxGapMs: 30,
  minLength: 4,
  terminatingKey: "Enter",
  prefix: "",
  suffix: "",
  debounceMs: 300,
  useEventCode: true,
  stripLeakedChars: true,
};

/** event.code → character (physical QWERTY positions), for scans
 *  arriving while a non-Latin layout (e.g. Urdu) is active. */
export function charFromEventCode(e: KeyboardEvent): string {
  const code = e.code ?? "";
  let m = code.match(/^Key([A-Z])$/);
  if (m) return m[1]!.toLowerCase();
  m = code.match(/^Digit(\d)$/);
  if (m) return m[1]!;
  // Numpad digits and punctuation keys seen in the wild:
  m = code.match(/^Numpad(\d)$/);
  if (m) return m[1]!;
  switch (code) {
    case "Minus": return "-";
    case "Period": return ".";
    case "Comma": return ",";
    case "Slash": return "/";
    case "Backslash": return "\\";
    case "Space": return " ";
    default: return "";
  }
}

/** Best character for a keystroke: layout-independent when enabled. */
function charOf(e: KeyboardEvent, useEventCode: boolean): string {
  if (useEventCode) {
    const viaCode = charFromEventCode(e);
    if (viaCode) return viaCode;
  }
  return e.key.length === 1 ? e.key : "";
}

interface BufferState {
  text: string;
  lastAt: number;
  leakedFrom: { target: EventTarget & Element; length: number } | null;
}

export interface UseScanInputOptions extends Partial<ScanSettingsInput> {
  onScan: (code: string) => void;
  enabled?: boolean;
}

export function useScanInput({
  onScan,
  enabled = true,
  maxGapMs = DEFAULT_SCAN_SETTINGS.maxGapMs,
  minLength = DEFAULT_SCAN_SETTINGS.minLength,
  terminatingKey = DEFAULT_SCAN_SETTINGS.terminatingKey,
  prefix = DEFAULT_SCAN_SETTINGS.prefix,
  suffix = DEFAULT_SCAN_SETTINGS.suffix,
  debounceMs = DEFAULT_SCAN_SETTINGS.debounceMs,
  useEventCode = DEFAULT_SCAN_SETTINGS.useEventCode,
  stripLeakedChars = DEFAULT_SCAN_SETTINGS.stripLeakedChars,
}: UseScanInputOptions): void {
  const onScanRef = React.useRef(onScan);
  React.useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const settingsRef = React.useRef({ maxGapMs, minLength, terminatingKey, prefix, suffix, debounceMs, useEventCode, stripLeakedChars, enabled });
  settingsRef.current = { maxGapMs, minLength, terminatingKey, prefix, suffix, debounceMs, useEventCode, stripLeakedChars, enabled };

  const lastAcceptedRef = React.useRef<{ code: string; at: number }>({ code: "", at: 0 });

  React.useEffect(() => {
    const buffer: BufferState = { text: "", lastAt: 0, leakedFrom: null };

    const isEditable = (el: EventTarget | null): boolean =>
      el instanceof Element &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        (el as HTMLElement).isContentEditable);

    const handleKeyDown = (e: KeyboardEvent) => {
      const s = settingsRef.current;
      if (!s.enabled) return;

      if (e.key === s.terminatingKey) {
        const warm = buffer.lastAt > 0 && Date.now() - buffer.lastAt < 1000;
        if (buffer.text.length >= s.minLength && warm) {
          e.preventDefault();
          e.stopPropagation();

          let code = buffer.text;
          if (s.prefix && code.startsWith(s.prefix)) code = code.slice(s.prefix.length);
          if (s.suffix && code.endsWith(s.suffix)) code = code.slice(0, -s.suffix.length);

          // Leaked-character removal: the burst began inside an editable
          // field and typed its first N chars there — undo that damage.
          if (s.stripLeakedChars && buffer.leakedFrom) {
            const { target, length } = buffer.leakedFrom;
            const el = target as HTMLInputElement | HTMLTextAreaElement;
            try {
              const cur = el.value ?? "";
              if (cur.length >= length && cur.slice(-length) === buffer.text.slice(0, length)) {
                el.value = cur.slice(0, cur.length - length);
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }
            } catch {
              /* element may have unmounted mid-burst */
            }
          }

          buffer.text = "";
          buffer.lastAt = 0;
          buffer.leakedFrom = null;

          const now = Date.now();
          if (
            s.debounceMs > 0 &&
            code === lastAcceptedRef.current.code &&
            now - lastAcceptedRef.current.at < s.debounceMs
          ) {
            return; // double-scan suppressed
          }
          lastAcceptedRef.current = { code, at: now };

          if (code) onScanRef.current(code);
        }
        return;
      }

      const ch = charOf(e, s.useEventCode);
      if (!ch) return;

      const now = Date.now();
      if (now - buffer.lastAt > s.maxGapMs) {
        buffer.text = "";
        buffer.leakedFrom = null;
      }
      if (buffer.text.length === 0 && isEditable(e.target)) {
        // First char of the burst landed in a field — remember it so the
        // terminator handler can remove the leaked characters.
        buffer.leakedFrom = { target: e.target as EventTarget & Element, length: 0 };
      }
      if (buffer.leakedFrom && buffer.leakedFrom.target === e.target) {
        buffer.leakedFrom.length++;
      }
      buffer.text += ch;
      buffer.lastAt = now;
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
