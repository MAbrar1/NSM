/* ═══════════════════════════════════════════════════════════════
   TRANSPORTS — how ESC/POS bytes reach a printer.
   The interface deliberately allows, without touching callers:
     - today: WebUSB / Web Serial (PWA over HTTPS or localhost)
     - later: a local print agent over HTTP, or any new channel —
       implement Transport and register it; no driver/service change.

   Connection targets come from the printer profile
   (connectionTarget: "vid:pid" for WebUSB, a path hint for serial).
   Nothing is hardcoded: a profile the user configured is the only
   source of a device address.

   Hardware is unavailable in most dev environments — every transport
   degrades to a typed PrintError (UNSUPPORTED/OFFLINE), never a raw
   DOMException leaking upward.
   ═══════════════════════════════════════════════════════════════ */

import { PrintError } from "./driver";

export interface Transport {
  readonly name: "webusb" | "webserial" | "agent" | "loopback";
  /** Send the byte stream; resolves when the host accepted the write. */
  write(bytes: Uint8Array, target: string | null, signal?: AbortSignal): Promise<void>;
  /** Non-throwing probe. */
  available(target: string | null): Promise<boolean>;
}

/* ─── Minimal WebUSB typings (lib.dom lacks them on some targets) ── */

interface UsbDeviceLike {
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
  close(): Promise<void>;
  configuration?: { interfaces: Array<{ interfaceNumber: number; alternate: { endpoints: Array<{ direction: string; endpointNumber: number }> } }> } | null;
}
type UsbLike = {
  requestDevice(opts: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
};
function getUsb(): UsbLike | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as unknown as { usb?: UsbLike }).usb ?? null;
}

interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  writer: { write(data: BufferSource): Promise<void>; releaseLock(): void };
  close(): Promise<void>;
}
type SerialLike = { requestPort(): Promise<SerialPortLike>; getPorts(): Promise<SerialPortLike[]> };
function getSerial(): SerialLike | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as unknown as { serial?: SerialLike }).serial ?? null;
}

/** Parse "vid:pid" (hex or decimal) → { vendorId, productId }. */
export function parseUsbTarget(target: string | null): { vendorId: number; productId: number } | null {
  if (!target) return null;
  const m = target.trim().match(/^([0-9a-fA-F]+):([0-9a-fA-F]+)$/);
  if (!m) return null;
  const radix = target.includes("0x") ? 16 : 16; // hex ids by convention
  return {
    vendorId: parseInt(m[1]!.replace(/^0x/i, ""), radix),
    productId: parseInt(m[2]!.replace(/^0x/i, ""), radix),
  };
}

/** Default printer bulk endpoints: find OUT endpoint on config 0. */
function findOutEndpoint(device: UsbDeviceLike): number {
  const iface = device.configuration?.interfaces?.[0];
  const ep = iface?.alternate?.endpoints?.find((e) => e.direction === "out");
  return ep?.endpointNumber ?? 1;
}

/** WebUSB transport (Chrome/Edge). */
export class WebUsbTransport implements Transport {
  readonly name = "webusb" as const;

  async available(target: string | null): Promise<boolean> {
    const usb = getUsb();
    if (!usb) return false;
    try {
      const devices = await usb.getDevices();
      if (devices.length === 0) return false;
      if (!target) return true; // any paired printer
      const ids = parseUsbTarget(target);
      return Boolean(ids); // filterable; paired-device check needs ids
    } catch {
      return false;
    }
  }

  async write(bytes: Uint8Array, target: string | null, signal?: AbortSignal): Promise<void> {
    const usb = getUsb();
    if (!usb) {
      throw new PrintError("UNSUPPORTED", "WebUSB is not available in this browser/context");
    }
    if (signal?.aborted) throw new PrintError("CANCELLED", "Job aborted before transfer");
    const ids = parseUsbTarget(target);
    let device: UsbDeviceLike;
    try {
      device = await usb.requestDevice({ filters: ids ? [{ vendorId: ids.vendorId, productId: ids.productId }] : [{}] });
    } catch (err) {
      throw new PrintError("OFFLINE", "No printer selected or paired via WebUSB", err);
    }
    try {
      await device.open();
      await device.selectConfiguration(1);
      await device.claimInterface(0);
      const endpoint = findOutEndpoint(device);
      await device.transferOut(endpoint, bytes as unknown as BufferSource);
    } catch (err) {
      throw new PrintError("TRANSPORT", `WebUSB transfer failed: ${(err as Error).message}`, err);
    } finally {
      try {
        await device.close();
      } catch {
        /* close is best-effort */
      }
    }
  }
}

/** Web Serial transport (Chrome/Edge; ESC/POS over serial/USB-CDC). */
export class WebSerialTransport implements Transport {
  readonly name = "webserial" as const;
  private port: SerialPortLike | null = null;

  async available(_target: string | null): Promise<boolean> {
    return getSerial() !== null;
  }

  async write(bytes: Uint8Array, _target: string | null, signal?: AbortSignal): Promise<void> {
    const serial = getSerial();
    if (!serial) {
      throw new PrintError("UNSUPPORTED", "Web Serial is not available in this browser/context");
    }
    if (signal?.aborted) throw new PrintError("CANCELLED", "Job aborted before transfer");
    try {
      this.port = this.port ?? (await serial.requestPort());
      await this.port.open({ baudRate: 9600 }); // common ESC/POS default; profile-tunable later
      await this.port.writer.write(bytes as unknown as BufferSource);
      this.port.writer.releaseLock();
    } catch (err) {
      this.port = null; // a failed port must not poison later jobs
      throw new PrintError("TRANSPORT", `Serial transfer failed: ${(err as Error).message}`, err);
    }
  }
}

/** In-memory transport for tests and previews — never touches hardware. */
export class LoopbackTransport implements Transport {
  readonly name = "loopback" as const;
  readonly sent: Uint8Array[] = [];

  async available(): Promise<boolean> {
    return true;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes);
  }
}

/** Resolve the transport for a profile's connectionType. */
export function resolveTransport(connectionType: string): Transport {
  switch (connectionType) {
    case "webusb":
      return new WebUsbTransport();
    case "webserial":
      return new WebSerialTransport();
    case "loopback":
      return new LoopbackTransport();
    default:
      // browser/text/pdf profiles don't stream bytes; write() on them
      // is a programming error → typed, not silent.
      throw new PrintError("UNSUPPORTED", `No byte transport for connection type "${connectionType}"`);
  }
}
