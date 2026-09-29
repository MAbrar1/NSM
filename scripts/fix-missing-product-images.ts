/* One-off data fix: clear product image references whose upload files no
   longer exist (they 404 in the products table and logs).

   - imageUrl pointing at /api/files/<name> where uploads/<name> is gone
     → set back to NULL.
   - entries inside the images JSON gallery whose file is gone → removed.
   Idempotent: re-running finds nothing to fix. */
import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";
import { join } from "node:path";

const db = new PrismaClient();
const UPLOADS = join(process.cwd(), "uploads");

async function main() {

/** /api/files/<name> → uploads/<name> exists? Non-file URLs are ignored. */
function fileMissing(url: string): boolean {
  const m = url.match(/\/api\/files\/([^/?#]+)/);
  if (!m) return false; // external URLs etc. — not our cleanup target
  return !existsSync(join(UPLOADS, decodeURIComponent(m[1]!)));
}

const products = await db.product.findMany({
  where: { OR: [{ imageUrl: { not: null } }, { images: { not: null } }] },
  select: { id: true, name: true, imageUrl: true, images: true },
});

let clearedCover = 0;
let clearedGallery = 0;

for (const p of products) {
  const data: { imageUrl?: null; images?: string } = {};

  if (p.imageUrl && fileMissing(p.imageUrl)) {
    data.imageUrl = null;
    clearedCover += 1;
  }

  if (p.images) {
    try {
      const parsed: unknown = JSON.parse(p.images);
      if (Array.isArray(parsed)) {
        const kept = parsed.filter(
          (u): u is string => typeof u === "string" && !fileMissing(u)
        );
        if (kept.length !== parsed.length) {
          clearedGallery += parsed.length - kept.length;
          // Keep the column non-null only if something survived; the app
          // treats "[]" and null the same, but null is the cleaner value.
          data.images = kept.length > 0 ? JSON.stringify(kept) : null as unknown as string;
        }
      }
    } catch {
      /* unparseable gallery — leave it alone */
    }
  }

  if (Object.keys(data).length > 0) {
    await db.product.update({ where: { id: p.id }, data });
    console.log(`fixed ${p.name}: ${Object.keys(data).join(", ")}`);
  }
}

console.log(
  `done — cleared ${clearedCover} cover image(s), ${clearedGallery} gallery image(s)`
);
await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
