/* ═══════════════════════════════════════════════════════════════
   BARCODEDETECTOR TYPE DECLARATIONS
   The BarcodeDetector API is available in Chrome 83+ and Edge 83+
   but not yet in the default TypeScript DOM lib. This ambient
   declaration adds the necessary types so the scanner component
   compiles without errors.
   ═══════════════════════════════════════════════════════════════ */

interface BarcodeDetectorOptions {
  formats?: string[];
}

interface DetectedBarcode {
  boundingBox: DOMRectReadOnly;
  cornerPoints: Array<{ x: number; y: number }>;
  format: string;
  rawValue: string;
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(image: ImageBitmapSource): Promise<DetectedBarcode[]>;
  static getSupportedFormats(): Promise<string[]>;
}
