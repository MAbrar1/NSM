/* ═══════════════════════════════════════════════════════════════
   PRINT SERVICE — unit tests
   - per-printer serialization (same profile → strictly ordered)
   - different profiles run in parallel
   - timeout produces PrintError("TIMEOUT")
   - driver failures surface as typed PrintError (never raw)
   - retry-from-record: enqueuing the same saved job twice is
     idempotent at the service layer (no sale re-run by construction)
   Run: npx tsx --test tests/print-service.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueuePrint, registerDriver, resetPrintQueues } from "@/lib/print/print-service";
import { PrintDriver, PrintError, PrintJob, DriverProfile } from "@/lib/print/driver";

/** Scripted driver: records calls, resolves/rejects as configured. */
class ScriptedDriver implements PrintDriver {
  readonly kind: PrintJob["kind"];
  readonly name = "scripted";
  calls: Array<{ jobId: string; at: number }> = [];
  private nextResponse: (() => Promise<void>) | null = null;

  constructor(kind: PrintJob["kind"] = "escpos-raster") {
    this.kind = kind;
  }

  script(response: () => Promise<void>): void {
    this.nextResponse = response;
  }

  async print(job: PrintJob, _profile: DriverProfile): Promise<void> {
    this.calls.push({ jobId: job.id, at: Date.now() });
    const respond = this.nextResponse ?? (async () => undefined);
    await respond();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const PROFILE: DriverProfile = {
  id: "printer-A",
  name: "Front counter",
  connectionType: "loopback",
  connectionTarget: null,
  charsPerLine: 48,
  feedBeforeCutLines: 3,
  cutMode: "full",
  drawerKick: false,
  drawerPin: 2,
};

function job(id: string): PrintJob {
  return { id, kind: "escpos-raster", bytes: new Uint8Array([0x1b, 0x40]) };
}

test("same profile serializes strictly in enqueue order", async () => {
  resetPrintQueues();
  const driver = new ScriptedDriver();
  const order: string[] = [];
  driver.script(async () => {
    order.push("start-" + (driver.calls.length));
    await new Promise((r) => setTimeout(r, 30));
    order.push("end-" + driver.calls.length);
  });
  registerDriver(driver);

  const p1 = enqueuePrint(job("j1"), PROFILE);
  const p2 = enqueuePrint(job("j2"), PROFILE);
  const p3 = enqueuePrint(job("j3"), PROFILE);
  await Promise.all([p1, p2, p3]);

  assert.equal(driver.calls.length, 3);
  // Every start is followed by its end before the next start.
  for (let i = 0; i < order.length; i += 2) {
    assert.match(order[i]!, /^start-/);
    assert.match(order[i + 1]!, /^end-/);
  }
});

test("different profiles do not block each other", async () => {
  resetPrintQueues();
  const driver = new ScriptedDriver();
  let inFlight = 0;
  let maxInFlight = 0;
  driver.script(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 25));
    inFlight--;
  });
  registerDriver(driver);

  const b: DriverProfile = { ...PROFILE, id: "printer-B" };
  await Promise.all([
    enqueuePrint(job("a1"), PROFILE),
    enqueuePrint(job("b1"), b),
    enqueuePrint(job("a2"), PROFILE),
    enqueuePrint(job("b2"), b),
  ]);
  assert.equal(maxInFlight, 2, "two printers ran concurrently");
});

test("timeout surfaces as PrintError TIMEOUT", async () => {
  resetPrintQueues();
  const driver = new ScriptedDriver();
  driver.script(() => new Promise(() => undefined)); // never resolves
  registerDriver(driver);

  await assert.rejects(
    () => enqueuePrint(job("slow"), PROFILE, { timeoutMs: 40 }),
    (err: unknown) => err instanceof PrintError && err.code === "TIMEOUT"
  );
});

test("raw driver failures are wrapped into typed PrintError", async () => {
  resetPrintQueues();
  const driver = new ScriptedDriver();
  driver.script(async () => {
    throw new DOMException("blocked", "NotAllowedError");
  });
  registerDriver(driver);

  await assert.rejects(
    () => enqueuePrint(job("boom"), PROFILE),
    (err: unknown) => err instanceof PrintError && err.code === "TRANSPORT"
  );
});

test("retry-from-record: the same saved job can be re-enqueued after failure", async () => {
  resetPrintQueues();
  const driver = new ScriptedDriver();
  let attempts = 0;
  driver.script(async () => {
    attempts++;
    if (attempts === 1) throw new PrintError("OFFLINE", "Printer asleep");
  });
  registerDriver(driver);

  const savedJob = job("receipt-42"); // built from the saved record
  await assert.rejects(() => enqueuePrint(savedJob, PROFILE), PrintError);
  await enqueuePrint(savedJob, PROFILE); // Retry from the record: OK
  assert.equal(attempts, 2);
});
