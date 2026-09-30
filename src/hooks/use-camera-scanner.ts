"use client";

import * as React from "react";
import { normalizeScannedCode } from "@/lib/products/barcode";

/* ═══════════════════════════════════════════════════════════════
   USE-CAMERA-SCANNER — premium camera barcode/QR scanning engine.

   Strategy (in order):
   1. Native `BarcodeDetector` (Chrome/Edge/Android — zero bundle
      cost, fastest decode) when the browser exposes it.
   2. ZXing `BrowserMultiFormatReader` (pure-JS, works everywhere —
      Firefox, Safari/iOS, older Chrome) as the fallback.

   Features: environment-facing camera selection, manual device
   switching, torch (flashlight) toggle, optical zoom slider (when
   the lens supports it), continuous multi-scan mode with duplicate
   suppression, beep + haptic feedback, strict lifecycle cleanup
   (tracks stopped, ZXing loop halted, rAF cancelled) and a `state`
   machine (idle/requesting/streaming/denied/unsupported/error) that
   drives the UI.
   ═══════════════════════════════════════════════════════════════ */

export type CameraScannerState =
  | "idle"
  | "requesting"
  | "streaming"
  | "denied"
  | "unsupported"
  | "error";

export interface ScannerCapabilities {
  torch: boolean;
  zoom: boolean;
  zoomMin: number;
  zoomMax: number;
  zoomStep: number;
}

export interface UseCameraScannerOptions {
  /** Called for every accepted (non-duplicate) scan. */
  onScan: (rawValue: string) => void;
  /** Formats to detect. Default: all common retail 1D + 2D formats. */
  formats?: string[];
  /** ms in which an identical code is ignored (default 1200). */
  duplicateWindowMs?: number;
  /** Play a beep on each accepted scan (default true). */
  beep?: boolean;
  /** Vibrate on each accepted scan where supported (default true). */
  vibrate?: boolean;
}

/** Formats accepted by both engines; ZXing names are mapped below. */
const DEFAULT_DETECTOR_FORMATS = [
  "ean_13", "ean_8", "upc_a", "upc_e",
  "code_128", "code_39", "code_93", "codabar", "itf",
  "qr_code", "data_matrix", "pdf417", "aztec",
];

const ZXING_FORMAT_MAP: Record<string, unknown> = {
  ean_13: "EAN_13",
  ean_8: "EAN_8",
  upc_a: "UPC_A",
  upc_e: "UPC_E",
  code_128: "CODE_128",
  code_39: "CODE_39",
  code_93: "CODE_93",
  codabar: "CODABAR",
  itf: "ITF",
  qr_code: "QR_CODE",
  data_matrix: "DATA_MATRIX",
  pdf417: "PDF_417",
  aztec: "AZTEC",
};

/** Native BarcodeDetector typing (not yet in lib.dom for all targets). */
type DetectedBarcode = { rawValue: string; format: string };
type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};

function getNativeDetector(): (new (opts?: { formats?: string[] }) => BarcodeDetectorLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike };
  return w.BarcodeDetector ?? null;
}

/** Minimal beep via WebAudio — no asset, no autoplay policy issue (user gesture already happened). */
function playBeep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 2093; // high "scan" chirp
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    /* audio is best-effort */
  }
}

function buzz(): void {
  try {
    navigator.vibrate?.(60);
  } catch {
    /* haptics best-effort */
  }
}

export interface CameraScanner {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  state: CameraScannerState;
  errorMessage: string | null;
  engine: "native" | "zxing" | null;
  cameras: MediaDeviceInfo[];
  activeDeviceId: string | null;
  capabilities: ScannerCapabilities;
  torchOn: boolean;
  zoom: number | null;
  start: (deviceId?: string) => Promise<void>;
  stop: () => void;
  switchCamera: (deviceId: string) => void;
  toggleTorch: () => Promise<void>;
  setZoom: (value: number) => void;
}

export function useCameraScanner({
  onScan,
  formats,
  duplicateWindowMs = 1200,
  beep = true,
  vibrate = true,
}: UseCameraScannerOptions): CameraScanner {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const zxingControlsRef = React.useRef<{ stop: () => void } | null>(null);
  const zxingReaderRef = React.useRef<{ stop: () => void } | null>(null);
  const lastScanRef = React.useRef<{ value: string; at: number }>({ value: "", at: 0 });
  const detectorRef = React.useRef<BarcodeDetectorLike | null>(null);
  const onScanRef = React.useRef(onScan);
  const optsRef = React.useRef({ beep, vibrate, duplicateWindowMs });
  optsRef.current = { beep, vibrate, duplicateWindowMs };

  const [state, setState] = React.useState<CameraScannerState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [engine, setEngine] = React.useState<"native" | "zxing" | null>(null);
  const [cameras, setCameras] = React.useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = React.useState<string | null>(null);
  const [capabilities, setCapabilities] = React.useState<ScannerCapabilities>({
    torch: false, zoom: false, zoomMin: 1, zoomMax: 1, zoomStep: 0.1,
  });
  const [torchOn, setTorchOn] = React.useState(false);
  const [zoom, setZoomState] = React.useState<number | null>(null);

  // Keep the latest callback without re-binding the scan loop.
  React.useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  /** Accept a raw detection: dedupe, normalize, notify, feedback. */
  const acceptScan = React.useCallback((rawValue: string) => {
    const value = normalizeScannedCode(rawValue);
    if (!value) return;
    const now = Date.now();
    const { beep: doBeep, vibrate: doVibrate, duplicateWindowMs: windowMs } = optsRef.current;
    if (
      value === lastScanRef.current.value &&
      now - lastScanRef.current.at < windowMs
    ) {
      return; // same code within the duplicate window
    }
    lastScanRef.current = { value, at: now };
    if (doBeep) playBeep();
    if (doVibrate) buzz();
    onScanRef.current(rawValue);
  }, []);

  /** Read torch/zoom capabilities off the active track. */
  const readCapabilities = React.useCallback((track: MediaStreamTrack) => {
    try {
      const caps = track.getCapabilities?.() as (MediaTrackCapabilities & {
        torch?: boolean;
        zoom?: { min: number; max: number; step?: number };
      }) | undefined;
      const zoomCaps = caps?.zoom;
      setCapabilities({
        torch: Boolean(caps?.torch),
        zoom: Boolean(zoomCaps && zoomCaps.max > zoomCaps.min),
        zoomMin: zoomCaps?.min ?? 1,
        zoomMax: zoomCaps?.max ?? 1,
        zoomStep: zoomCaps?.step ?? 0.1,
      });
      if (zoomCaps && zoomCaps.max > zoomCaps.min) {
        setZoomState(typeof track.getSettings().zoom === "number" ? (track.getSettings().zoom as number) : zoomCaps.min);
      } else {
        setZoomState(null);
      }
    } catch {
      setCapabilities({ torch: false, zoom: false, zoomMin: 1, zoomMax: 1, zoomStep: 0.1 });
      setZoomState(null);
    }
  }, []);

  /** Stop everything: rAF loop, ZXing scanner, stream tracks, torch. */
  const stop = React.useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try { zxingControlsRef.current?.stop(); } catch { /* noop */ }
    zxingControlsRef.current = null;
    try { zxingReaderRef.current?.stop?.(); } catch { /* noop */ }
    zxingReaderRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    setState("idle");
    setTorchOn(false);
  }, []);

  const start = React.useCallback(
    async (deviceId?: string) => {
      // Tear down any previous session first.
      stop();

      const NativeDetector = getNativeDetector();
      if (!NativeDetector && typeof window === "undefined") return;

      setState("requesting");
      setErrorMessage(null);

      const video = videoRef.current;
      if (!video) {
        setState("error");
        setErrorMessage("Video element not mounted yet.");
        return;
      }

      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        const name = (err as DOMException)?.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          setState("denied");
          setErrorMessage("Camera permission was denied. Allow camera access and try again.");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setState("error");
          setErrorMessage("No usable camera found on this device.");
        } else {
          setState("error");
          setErrorMessage(`Could not start the camera: ${(err as Error)?.message ?? name}`);
        }
        return;
      }

      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (track) readCapabilities(track);

      video.srcObject = stream;
      video.setAttribute("playsinline", "true"); // iOS Safari full-screen prevention
      try {
        await video.play();
      } catch {
        /* play() can reject on interrupted loads; the loop still runs */
      }
      setActiveDeviceId(track?.getSettings().deviceId ?? deviceId ?? null);

      // Populate the camera list now that labels are readable (post-permission).
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCameras(devices.filter((d) => d.kind === "videoinput"));
      } catch {
        /* listing is best-effort */
      }

      // ── Engine 1: native BarcodeDetector ──────────────────────
      if (NativeDetector) {
        try {
          const detector = new NativeDetector({
            formats: formats ?? DEFAULT_DETECTOR_FORMATS,
          });
          // Some browsers throw only on first detect() for a bad format list.
          const probeCanvas = document.createElement("canvas");
          probeCanvas.width = 1;
          probeCanvas.height = 1;
          await detector.detect(probeCanvas);
          detectorRef.current = detector;
          setEngine("native");
          setState("streaming");

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          let busy = false;

          const loop = async () => {
            // The rAF handle is cancelled on stop(), which ends the loop.
            if (!detectorRef.current) return;
            if (video.readyState >= 2 && video.videoWidth > 0 && !busy) {
              busy = true;
              try {
                // Decode the CENTER CROP (middle ~60%) — improves speed
                // and reliability for 1D retail barcodes.
                const cw = Math.floor(video.videoWidth * 0.6);
                const ch = Math.floor(video.videoHeight * 0.6);
                canvas.width = cw;
                canvas.height = ch;
                ctx?.drawImage(
                  video,
                  Math.floor(video.videoWidth * 0.2),
                  Math.floor(video.videoHeight * 0.2),
                  cw,
                  ch,
                  0, 0, cw, ch
                );
                const found = await detectorRef.current.detect(canvas);
                if (found.length > 0) acceptScan(found[0]!.rawValue);
              } catch {
                /* transient decode errors are expected between frames */
              } finally {
                busy = false;
              }
            }
            rafRef.current = requestAnimationFrame(loop);
          };
          rafRef.current = requestAnimationFrame(loop);
          return;
        } catch {
          // Native detector advertised but failed — fall through to ZXing.
          detectorRef.current = null;
        }
      }

      // ── Engine 2: ZXing fallback (pure JS, works everywhere) ──
      try {
        const [{ BrowserMultiFormatReader }, zxlib] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        const { DecodeHintType } = zxlib;
        const hints = new Map();
        const wanted = (formats ?? DEFAULT_DETECTOR_FORMATS)
          .map((f) => ZXING_FORMAT_MAP[f])
          .filter(Boolean);
        if (wanted.length > 0) {
          hints.set(DecodeHintType.POSSIBLE_FORMATS, wanted);
        }
        hints.set(DecodeHintType.TRY_HARDER, true);
        const reader = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 120,
          delayBetweenScanSuccess: duplicateWindowMs,
        });
        zxingReaderRef.current = reader as unknown as { stop: () => void };
        const controls = await reader.decodeFromStream(stream, video, (result) => {
          if (result) acceptScan(result.getText());
        });
        zxingControlsRef.current = controls;
        setEngine("zxing");
        setState("streaming");
      } catch (err) {
        for (const t of stream.getTracks()) t.stop();
        streamRef.current = null;
        setState("error");
        setErrorMessage(`Scanner engine failed to start: ${(err as Error)?.message ?? "unknown"}`);
      }
    },
    [acceptScan, duplicateWindowMs, formats, readCapabilities, stop]
  );

  const switchCamera = React.useCallback(
    (deviceId: string) => {
      void start(deviceId);
    },
    [start]
  );

  const toggleTorch = React.useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` is not yet in MediaTrackConstraintSet's TS types.
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      /* torch not actually supported */
    }
  }, [torchOn]);

  const setZoom = React.useCallback((value: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    void track
      .applyConstraints({
        advanced: [{ zoom: value } as unknown as MediaTrackConstraintSet],
      })
      .then(() => setZoomState(value))
      .catch(() => {});
  }, []);

  // Hard cleanup on unmount.
  React.useEffect(() => stop, [stop]);

  return {
    videoRef,
    state,
    errorMessage,
    engine,
    cameras,
    activeDeviceId,
    capabilities,
    torchOn,
    zoom,
    start,
    stop,
    switchCamera,
    toggleTorch,
    setZoom,
  };
}
