/* ═══════════════════════════════════════════════════════════════
   MAINTENANCE SWEEP — unit tests
   Verifies orphan-image detection against a real temp filesystem with
   a stubbed catalog: referenced files survive, unreferenced files
   older than the grace period are deleted, and fresh unreferenced
   files are spared (in-flight upload protection).
   Run: npx tsx --test tests/maintenance.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm, utimes, stat } from "fs/promises";
import os from "os";
import path from "path";
import { db } from "@/lib/db";
import { sweepOrphanImages, ORPHAN_GRACE_MS } from "@/lib/maintenance";

const DAY = 24 * 60 * 60 * 1000;

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "maint-test-"));
  process.env["STORAGE_DRIVER"] = "local";
  process.env["UPLOAD_DIR"] = dir;
  return dir;
}

/** Write a file and optionally backdate its mtime. */
async function plant(name: string, dir: string, ageMs: number): Promise<void> {
  await writeFile(path.join(dir, name), "x");
  const old = new Date(Date.now() - ageMs);
  await utimes(path.join(dir, name), old, old);
}

test("deletes old unreferenced files, keeps referenced ones", async () => {
  const dir = await scratchDir();
  // Two managed-looking files on disk.
  await plant("kept-1111.png", dir, 2 * DAY); // referenced below
  await plant("orphan-2222.jpg", dir, 2 * DAY); // unreferenced + old

  // Stub the catalog: kept-1111.png is referenced by a product.
  const origFindMany = db.product.findMany.bind(db.product);
  const origVariantFind = db.productVariant.findMany.bind(db.productVariant);
  (db.product.findMany as unknown) = async () => [
    { imageUrl: "/api/files/kept-1111.png", images: null },
  ];
  (db.productVariant.findMany as unknown) = async () => [];

  try {
    const { deleted, scanned } = await sweepOrphanImages();
    assert.deepEqual(deleted, ["orphan-2222.jpg"]);
    assert.equal(scanned, 2);

    const remaining = await readdir(dir);
    assert.deepEqual(remaining, ["kept-1111.png"]);
  } finally {
    (db.product.findMany as unknown) = origFindMany;
    (db.productVariant.findMany as unknown) = origVariantFind;
    await rm(dir, { recursive: true, force: true });
  }
});

test("spares unreferenced files younger than the grace period", async () => {
  const dir = await scratchDir();
  await plant("fresh-3333.png", dir, 60 * 1000); // 1 minute old

  const origFindMany = db.product.findMany.bind(db.product);
  const origVariantFind = db.productVariant.findMany.bind(db.productVariant);
  (db.product.findMany as unknown) = async () => [];
  (db.productVariant.findMany as unknown) = async () => [];

  try {
    const { deleted, scanned } = await sweepOrphanImages();
    assert.deepEqual(deleted, []);
    assert.equal(scanned, 1);
    const remaining = await readdir(dir);
    assert.deepEqual(remaining, ["fresh-3333.png"]);
  } finally {
    (db.product.findMany as unknown) = origFindMany;
    (db.productVariant.findMany as unknown) = origVariantFind;
    await rm(dir, { recursive: true, force: true });
  }
});

test("collects references from galleries and variants too", async () => {
  const dir = await scratchDir();
  await plant("gallery-4444.png", dir, 2 * DAY);
  await plant("variant-5555.png", dir, 2 * DAY);
  await plant("orphan-6666.gif", dir, 2 * DAY);

  const origFindMany = db.product.findMany.bind(db.product);
  const origVariantFind = db.productVariant.findMany.bind(db.productVariant);
  (db.product.findMany as unknown) = async () => [
    { imageUrl: null, images: JSON.stringify(["/api/files/gallery-4444.png"]) },
  ];
  (db.productVariant.findMany as unknown) = async () => [
    { imageUrl: "/api/files/variant-5555.png" },
  ];

  try {
    const { deleted, scanned } = await sweepOrphanImages();
    assert.deepEqual(deleted.sort(), ["orphan-6666.gif"]);
    assert.equal(scanned, 3);
    const remaining = (await readdir(dir)).sort();
    assert.deepEqual(remaining, ["gallery-4444.png", "variant-5555.png"]);
  } finally {
    (db.product.findMany as unknown) = origFindMany;
    (db.productVariant.findMany as unknown) = origVariantFind;
    await rm(dir, { recursive: true, force: true });
  }
});

test("grace-period constant is 24 hours", () => {
  assert.equal(ORPHAN_GRACE_MS, DAY);
});