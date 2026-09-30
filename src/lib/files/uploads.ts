import { randomUUID } from "crypto";
import { mkdir, writeFile, unlink, access, readdir } from "fs/promises";
import path from "path";
import {
  deleteObject,
  isS3Configured,
  listObjects,
  presignedGetUrl,
  putObject,
} from "@/lib/files/s3-client";

/* ═══════════════════════════════════════════════════════════════
   IMAGE UPLOADS
   Product images are stored outside the database and served by
   GET /api/files/[name]. Two storage drivers:

   - local (default) — filesystem under UPLOAD_DIR (./uploads),
     served straight from disk by the files route.
   - s3 — any S3-compatible bucket (AWS/R2/MinIO/B2/Spaces) via
     src/lib/s3-client.ts. The files route 302-redirects to a short
     presigned GET URL; the DB stores the same /api/files/<name> URL.

   Legacy base64 data-URL images keep working untouched in both modes.

   Env: STORAGE_DRIVER=local|s3 (default local), UPLOAD_DIR,
        plus S3_* vars (see s3-client.ts).
   ═══════════════════════════════════════════════════════════════ */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMAGES_PER_PRODUCT = 10;

export const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** MIME → file extension map (kept tiny and explicit). */
const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type StorageDriver = "local" | "s3";

/** Which driver is active (explicit override wins; S3 needs full config). */
export function storageDriver(): StorageDriver {
  const explicit = process.env["STORAGE_DRIVER"]?.trim().toLowerCase();
  if (explicit === "s3") return "s3";
  if (explicit === "local") return "local";
  return isS3Configured() ? "s3" : "local";
}

/** Resolve the configured upload directory (absolute). */
export function getUploadDir(): string {
  const dir = process.env["UPLOAD_DIR"]?.trim() || "./uploads";
  return path.resolve(dir);
}

/** The URL path a saved file is served at (same for both drivers). */
export function fileUrl(name: string): string {
  return `/api/files/${encodeURIComponent(name)}`;
}

/** Is this gallery entry one of our file-backed URLs? */
export function isManagedFileUrl(url: string): boolean {
  return /^\/api\/files\/[A-Za-z0-9._-]+$/.test(url);
}

/** Extract the file name from a managed URL, or null. */
export function fileNameFromUrl(url: string): string | null {
  const m = /^\/api\/files\/([A-Za-z0-9._-]+)$/.exec(url);
  return m ? m[1]! : null;
}

export interface ImageFileMeta {
  name: string;
  /** ISO timestamp of last modification, or null when unknown. */
  lastModified: string | null;
}

/**
 * List every stored image file (name + last-modified) so maintenance
 * can sweep orphans. Names are the object keys / file names used in
 * /api/files URLs.
 */
export async function listImageFiles(): Promise<ImageFileMeta[]> {
  if (storageDriver() === "s3") {
    const objects = await listObjects("");
    return objects
      .filter((o) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.key))
      .map((o) => ({ name: o.key, lastModified: o.lastModified }));
  }
  const dir = getUploadDir();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.name))
      .map((e) => ({ name: e.name, lastModified: null }));
  } catch {
    return []; // dir doesn't exist yet — nothing stored
  }
}

/**
 * Validate + persist an uploaded image file. Returns the public URL
 * (`/api/files/<name>`) or throws with a user-facing message.
 */
export async function saveImageFile(
  file: File,
  opts?: { dir?: string }
): Promise<string> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Invalid file type. Allowed: JPEG, PNG, WebP, GIF");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("File too large. Maximum size: 5MB");
  }

  const ext = EXT_BY_TYPE[file.type] ?? "img";
  const name = `${randomUUID()}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  if (storageDriver() === "s3") {
    await putObject(name, bytes, file.type);
    return fileUrl(name);
  }

  const dir = opts?.dir ?? getUploadDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), bytes);
  return fileUrl(name);
}

/** Delete a managed file (if it exists). Never throws on a miss. */
export async function deleteImageFile(
  url: string,
  opts?: { dir?: string }
): Promise<void> {
  const name = fileNameFromUrl(url);
  if (!name) return; // data URLs / external URLs are not ours to delete

  if (storageDriver() === "s3") {
    await deleteObject(name);
    return;
  }

  const filePath = path.join(opts?.dir ?? getUploadDir(), name);
  try {
    await access(filePath);
    await unlink(filePath);
  } catch {
    // Missing file is fine — nothing to clean up.
  }
}

/**
 * Resolve the actual bytes for a stored file (local: read from disk).
 * S3-backed files are never read here — the files route redirects to a
 * presigned URL instead. Throws when the file is missing.
 */
export async function readImageFile(
  name: string,
  opts?: { dir?: string }
): Promise<Buffer> {
  if (storageDriver() === "s3") {
    throw new Error("S3-backed files are served via presigned redirects");
  }
  const { readFile } = await import("fs/promises");
  return readFile(path.join(opts?.dir ?? getUploadDir(), name));
}

/** Presigned GET URL for an S3-backed file (local mode → null). */
export async function presignedImageUrl(
  name: string,
  expiresInSeconds = 3600
): Promise<string | null> {
  if (storageDriver() !== "s3") return null;
  return presignedGetUrl(name, expiresInSeconds);
}

/** Best-effort content type for a stored file name. */
export function contentTypeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

/** Parse the stored `images` JSON column defensively. */
export function parseImageGallery(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}