import { db } from "@/lib/db";
import { pruneLoginAttempts } from "@/lib/rate-limit";
import {
  isManagedFileUrl,
  listImageFiles,
  parseImageGallery,
  deleteImageFile,
  getUploadDir,
} from "@/lib/files/uploads";
import { stat } from "fs/promises";
import path from "path";

/* ═══════════════════════════════════════════════════════════════
   MAINTENANCE SWEEP
   Periodic housekeeping for resources that grow without bounds:

   1. Login-attempt rows older than the retention window (24h) — the
      rate limiter already prunes opportunistically on new traffic;
      this sweep guarantees cleanup even on quiet deployments.
   2. Orphaned image files — any file in the uploads bucket (local or
      S3) that no product/variant references. Files younger than the
      grace period are kept so an upload that is mid-flight (file on
      disk, DB row not yet committed) is never deleted.

   Runs on an interval in instrumentation.ts under `next start`; the
   low-stock notification route already demonstrates the platform-cron
   pattern if you prefer external scheduling.
   ═══════════════════════════════════════════════════════════════ */

/** How long an unreferenced file may sit before the sweep deletes it. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface MaintenanceResult {
  prunedLoginAttempts: number;
  deletedOrphans: string[];
  scannedFiles: number;
}

/** Every image URL currently referenced anywhere in the catalog. */
async function collectReferencedUrls(): Promise<Set<string>> {
  const refs = new Set<string>();

  const addProduct = (p: { imageUrl: string | null; images: string | null }) => {
    if (p.imageUrl && isManagedFileUrl(p.imageUrl)) refs.add(p.imageUrl);
    for (const url of parseImageGallery(p.images)) {
      if (isManagedFileUrl(url)) refs.add(url);
    }
  };

  // Batched scan — one pass per table, no N+1.
  const [products, variants] = await Promise.all([
    db.product.findMany({
      where: { deletedAt: null },
      select: { imageUrl: true, images: true },
    }),
    db.productVariant.findMany({
      where: { isActive: true },
      select: { imageUrl: true },
    }),
  ]);
  for (const p of products) addProduct(p);
  for (const v of variants) {
    if (v.imageUrl && isManagedFileUrl(v.imageUrl)) refs.add(v.imageUrl);
  }
  return refs;
}

/**
 * Delete image files (local or S3) that no catalog row references and
 * that are older than the grace period. Returns the deleted names and
 * the total number of stored files scanned.
 */
export async function sweepOrphanImages(
  graceMs = ORPHAN_GRACE_MS
): Promise<{ deleted: string[]; scanned: number }> {
  const referenced = await collectReferencedUrls();
  const files = await listImageFiles();
  const cutoff = Date.now() - graceMs;

  const deleted: string[] = [];
  for (const file of files) {
    const url = `/api/files/${file.name}`;
    if (referenced.has(url)) continue;

    // Skip files too young to be safe (in-flight uploads).
    if (file.lastModified) {
      const modified = new Date(file.lastModified).getTime();
      if (Number.isFinite(modified) && modified > cutoff) continue;
    }
    // Local listing has no timestamps — fall back to a fresh stat.
    if (!file.lastModified) {
      try {
        const s = await stat(path.join(getUploadDir(), file.name));
        if (s.mtimeMs > cutoff) continue;
      } catch {
        continue; // vanished between list and stat — nothing to delete
      }
    }

    try {
      await deleteImageFile(url);
      deleted.push(file.name);
    } catch {
      // One bad object must not abort the whole sweep.
    }
  }
  return { deleted, scanned: files.length };
}

/** Run the full maintenance pass. Never throws. */
export async function runMaintenanceSweep(): Promise<MaintenanceResult> {
  const [prunedLoginAttempts, orphanSweep] = await Promise.all([
    pruneLoginAttempts().catch((err) => {
      console.error("[MAINTENANCE] login-attempt prune failed:", err);
      return 0;
    }),
    sweepOrphanImages().catch((err) => {
      console.error("[MAINTENANCE] orphan sweep failed:", err);
      return { deleted: [] as string[], scanned: 0 };
    }),
  ]);

  const deletedOrphans = orphanSweep.deleted;

  if (deletedOrphans.length > 0 || prunedLoginAttempts > 0) {
    console.log(
      `[MAINTENANCE] sweep: pruned ${prunedLoginAttempts} login attempts, deleted ${deletedOrphans.length} orphan files`
    );
  }
  return {
    prunedLoginAttempts,
    deletedOrphans,
    scannedFiles: orphanSweep.scanned,
  };
}