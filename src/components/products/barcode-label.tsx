"use client";

import * as React from "react";
import JsBarcode from "jsbarcode";
import { formatCurrencyBase, cn } from "@/lib/utils";
import { WHOLE_UNITS } from "@/lib/products/units";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";

/** Price suffix like " / kg" for loose goods (blank for pcs). */
function priceSuffix(unit?: string): string {
  return unit && !WHOLE_UNITS.has(unit) ? ` / ${unit}` : "";
}

/* ═══════════════════════════════════════════════════════════════
   BARCODE LABEL COMPONENT
   Generates printable barcode labels using SVG.
   Encodes real, scanner-readable Code 128 (auto switching between
   code sets A/B/C) via jsbarcode — the previous renderer only drew
   a deterministic fake pattern from char codes, which no scanner
   could actually decode.
   ═══════════════════════════════════════════════════════════════ */

interface BarcodeLabelProps {
  productName: string;
  sku: string;
  barcode?: string;
  price: number;
  unit?: string;
  size?: "sm" | "md" | "lg";
  showPrice?: boolean;
}

/** Real Code 128 SVG. Renders synchronously into the ref'd <svg>.
    Invalid input (empty value) falls back to plain text so a label
    can still be printed — just without a scannable symbol. */
function BarcodeSVG({ value, height = 50 }: { value: string; height?: number }) {
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useLayoutEffect(() => {
    if (!svgRef.current) return;
    try {
      JsBarcode(svgRef.current, value, {
        format: "CODE128",
        width: 2,
        height: Math.max(height - 16, 20),
        displayValue: true,
        fontSize: 10,
        font: "monospace",
        textMargin: 1,
        margin: 4,
        background: "#ffffff",
        lineColor: "#000000",
      });
      setFailed(false);
    } catch {
      // jsbarcode throws on values it cannot encode (e.g. empty string)
      setFailed(true);
    }
  }, [value, height]);

  return (
    <>
      {/* The svg must stay mounted even when hidden — the ref is how
          jsbarcode injects the symbol, and unmounting it would leave
          a failed render stuck after a value change. */}
      <svg ref={svgRef} className={cn("barcode-svg", failed && "hidden")} aria-hidden="true" />
      {failed && <p className="barcode-value-fallback font-mono text-[10px] text-black">{value}</p>}
    </>
  );
}

export function BarcodeLabel({
  productName,
  sku,
  barcode,
  price,
  unit,
  size = "md",
  showPrice = true,
}: BarcodeLabelProps) {
  const { t } = useI18n();
  const barcodeValue = barcode || sku;
  const labelRef = React.useRef<HTMLDivElement>(null);

  const sizeClasses = {
    sm: "w-[2in] p-2",
    md: "w-[3in] p-3",
    lg: "w-[4in] p-4",
  };

  const barHeight = { sm: 40, md: 50, lg: 65 };

  function handlePrint() {
    const content = labelRef.current;
    if (!content) return;

    const printWindow = window.open("", "_blank", "width=400,height=300");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Barcode Label - ${sku}</title>
        <style>
          body { margin: 0; padding: 10px; font-family: Arial, sans-serif; }
          .label { text-align: center; border: 1px solid #ddd; padding: 8px; }
          .product-name { font-size: 11px; font-weight: bold; margin: 4px 0; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .sku { font-size: 9px; color: #666; font-family: monospace; }
          .price { font-size: 14px; font-weight: bold; margin-top: 4px; }
          .price-unit { font-size: 9px; font-weight: normal; color: #666; }
          @media print {
            body { margin: 0; }
            .no-print { display: none; }
          }
        </style>
      </head>
      <body>
        <div class="label">
          ${content.innerHTML}
        </div>
        <script>
          window.onload = function() { window.print(); window.close(); }
        <\/script>
      </body>
      </html>
    `);
    printWindow.document.close();
  }

  return (
    <div>
      <div ref={labelRef} className={`barcode-label-card ${sizeClasses[size]}`}>
        <div className="text-center">
          <p className="product-name truncate" title={`${productName}`}>{productName}</p>
          <BarcodeSVG value={barcodeValue} height={barHeight[size]} />
          <p className="sku">{sku}</p>
          {/* Printed label: always the store base price (printed artifacts
              never follow the browser's display currency). */}
          {showPrice && (
            <p className="price">{formatCurrencyBase(price)}<span className="price-unit">{priceSuffix(unit)}</span></p>
          )}
        </div>
      </div>
      <div className="mt-2">
        <Button variant="secondary" size="sm" onClick={handlePrint}>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2h-4m0 10v4m0-4H9m3 0h3m-3-8a2 2 0 100-4h4a2 2 0 100 4m0 12V9m0 0L3 14m3-4v4m0 0h6" />
          </svg>
          {t("products.printLabel")}
        </Button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   BARCODE LABEL SHEET
   Print multiple labels in a grid layout.
   ═══════════════════════════════════════════════════════════════ */

interface LabelSheetItem {
  name: string;
  sku: string;
  barcode?: string;
  price: number;
  unit?: string;
}

export function BarcodeLabelSheet({ items }: { items: LabelSheetItem[] }) {
  const { t } = useI18n();
  const sheetRef = React.useRef<HTMLDivElement>(null);

  function handlePrintSheet() {
    const content = sheetRef.current;
    if (!content) return;

    const printWindow = window.open("", "_blank", "width=800,height=600");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Barcode Labels</title>
        <style>
          body { margin: 0; padding: 10px; font-family: Arial, sans-serif; }
          .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
          .label { text-align: center; border: 1px solid #ddd; padding: 6px; page-break-inside: avoid; }
          .name { font-size: 10px; font-weight: bold; margin: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .sku { font-size: 8px; color: #666; font-family: monospace; }
          .price { font-size: 12px; font-weight: bold; margin-top: 2px; }
          .price-unit { font-size: 8px; font-weight: normal; color: #666; }
          svg text { font-family: monospace; }
          @media print { body { margin: 0; } .no-print { display: none; } }
        </style>
      </head>
      <body>
        ${content.innerHTML}
        <script>window.onload = function() { window.print(); window.close(); }<\/script>
      </body>
      </html>
    `);
    printWindow.document.close();
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <p className="text-sm text-surface-600">
          {items.length} {t("products.labels")}
        </p>
        <Button variant="secondary" size="sm" onClick={handlePrintSheet} disabled={items.length === 0}>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2h-4m0 10v4m0-4H9m3 0h3m-3-8a2 2 0 100-4h4a2 2 0 100 4m0 12V9m0 0L3 14m3-4v4m0 0h6" />
          </svg>
          {t("products.printAllLabels")}
        </Button>
      </div>
      <div ref={sheetRef} className="grid grid-cols-3 gap-2">
        {items.map((item, i) => (
          <div key={i} className="text-center border border-surface-200 rounded p-2 bg-white">
            <p className="name truncate text-[10px] font-bold" title={`${item.name}`}>{item.name}</p>
            <BarcodeSVG value={item.barcode || item.sku} height={35} />
            <p className="sku text-[8px]">{item.sku}</p>
            <p className="price text-xs font-bold">
              {formatCurrencyBase(item.price)}<span className="price-unit">{priceSuffix(item.unit)}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
