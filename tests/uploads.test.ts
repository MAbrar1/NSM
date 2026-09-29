/* ═══════════════════════════════════════════════════════════════
   UPLOADS LIBRARY — unit tests
   Covers validation (MIME + size), URL/file-name round-trips, local
   persistence (write → list → delete), orphan detection helpers, and
   graceful handling of legacy base64 data-URLs. Each test uses its
   own temp directory so the suite is safe under parallel execution.
   Run: npx tsx --test tests/uploads.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
  contentTypeForName,
  deleteImageFile,
  fileNameFromUrl,
  isManagedFileUrl,
  listImageFiles,
  parseImageGallery,
  saveImageFile,
} from "@/lib/uploads";

/** Make a File-like object without the full DOM File in Node. */
function makeFile(bytes: Uint8Array, type: string, name = "test"): File {
  // Copy to an exact-size ArrayBuffer so BlobPart typing is satisfied.
  const copy = new Uint8Array(bytes);
  return new File([copy.buffer as ArrayBuffer], name, { type });
}

/** Isolated scratch directory per test — parallel-safe. */
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uploads-test-"));
  process.env["STORAGE_DRIVER"] = "local";
  process.env["UPLOAD_DIR"] = dir;
  return dir;
}

test("rejects unsupported MIME types", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => saveImageFile(makeFile(new TextEncoder().encode("x"), "text/plain"), { dir }),
    /Invalid file type/
  );
  await assert.rejects(
    () => saveImageFile(makeFile(new Uint8Array(1), "image/svg+xml"), { dir }),
    /Invalid file type/
  );
  await rm(dir, { recursive: true, force: true });
});

test("rejects oversized files", async () => {
  const dir = await scratchDir();
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  await assert.rejects(
    () => saveImageFile(makeFile(big, "image/png"), { dir }),
    /too large/i
  );
  await rm(dir, { recursive: true, force: true });
});

test("saves a valid image and returns a managed /api/files URL", async () => {
  const dir = await scratchDir();
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]); // PNG magic
  const url = await saveImageFile(makeFile(png, "image/png"), { dir });
  assert.match(url, /^\/api\/files\/[a-f0-9-]+\.png$/);

  const name = fileNameFromUrl(url)!;
  assert.ok(name);
  // Persisted bytes match exactly.
  const onDisk = await readFile(path.join(dir, name));
  assert.deepEqual([...onDisk], [...png]);
  await rm(dir, { recursive: true, force: true });
});

test("allows every configured MIME type and maps extensions", async () => {
  const dir = await scratchDir();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  for (const type of ALLOWED_IMAGE_TYPES) {
    const url = await saveImageFile(makeFile(new Uint8Array([1, 2, 3]), type), { dir });
    const name = fileNameFromUrl(url)!;
    const ext = name.split(".").pop()!;
    assert.equal(ext, map[type]);
    assert.equal(contentTypeForName(name), type);
  }
  await rm(dir, { recursive: true, force: true });
});

test("listImageFiles returns stored names; deleteImageFile removes them", async () => {
  const dir = await scratchDir();
  const url = await saveImageFile(makeFile(new Uint8Array([9, 9]), "image/webp"), { dir });
  const name = fileNameFromUrl(url)!;

  const listed = await listImageFiles();
  assert.ok(listed.some((f) => f.name === name), "file should be listed");

  await deleteImageFile(url, { dir });
  const after = await listImageFiles();
  assert.ok(!after.some((f) => f.name === name), "file should be gone");
  assert.equal((await readdir(dir)).length, 0, "directory should be empty");
  await rm(dir, { recursive: true, force: true });
});

test("deleteImageFile is a no-op for data URLs and external URLs", async () => {
  const dir = await scratchDir();
  // Must not throw and must not touch anything.
  await deleteImageFile("data:image/png;base64,AAAA");
  await deleteImageFile("https://example.com/logo.png");
  await deleteImageFile("/api/files/missing-file.png", { dir }); // absent file is fine
  await rm(dir, { recursive: true, force: true });
});

test("isManagedFileUrl / fileNameFromUrl round-trip", () => {
  assert.equal(isManagedFileUrl("/api/files/abc-123.png"), true);
  assert.equal(isManagedFileUrl("data:image/png;base64,AAAA"), false);
  assert.equal(isManagedFileUrl("https://cdn.example.com/x.png"), false);
  assert.equal(isManagedFileUrl("/api/files/../etc/passwd"), false);
  assert.equal(isManagedFileUrl("/api/files/name with space.png"), false);

  assert.equal(fileNameFromUrl("/api/files/abc-123.png"), "abc-123.png");
  assert.equal(fileNameFromUrl("data:image/png;base64,AAAA"), null);
});

test("parseImageGallery tolerates garbage", () => {
  assert.deepEqual(parseImageGallery(null), []);
  assert.deepEqual(parseImageGallery(undefined), []);
  assert.deepEqual(parseImageGallery("not json"), []);
  assert.deepEqual(parseImageGallery("42"), []);
  assert.deepEqual(
    parseImageGallery(JSON.stringify(["/api/files/a.png", "data:image/png;base64,x", 7, null])),
    ["/api/files/a.png", "data:image/png;base64,x"]
  );
  assert.equal(MAX_IMAGES_PER_PRODUCT, 10);
});

test("contentTypeForName falls back for unknown extensions", () => {
  assert.equal(contentTypeForName("photo.jpg"), "image/jpeg");
  assert.equal(contentTypeForName("photo.jpeg"), "image/jpeg");
  assert.equal(contentTypeForName("photo.webp"), "image/webp");
  assert.equal(contentTypeForName("photo.GIF"), "image/gif");
  assert.equal(contentTypeForName("photo.xyz"), "application/octet-stream");
});