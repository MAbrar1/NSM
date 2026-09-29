import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import path from "path";
import {
  contentTypeForName,
  getUploadDir,
  presignedImageUrl,
  readImageFile,
  storageDriver,
} from "@/lib/uploads";

/* ═══════════════════════════════════════════════════════════════
   FILE SERVING
   GET /api/files/:name — serve a stored product image.

   local mode: reads the file from disk (strict name + traversal
   validation, content type pinned from the extension, immutable
   cache headers).
   s3 mode: 302-redirects to a short-lived presigned GET URL so the
   bucket credentials never leave the server.
   ═══════════════════════════════════════════════════════════════ */

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await params;

    // Strict name policy: alphanumeric + dot/dash/underscore only.
    if (!SAFE_NAME.test(name)) {
      return apiError("Invalid file name", 400);
    }

    // S3-backed: hand the browser a short-lived presigned URL.
    if (storageDriver() === "s3") {
      const url = await presignedImageUrl(name);
      if (!url) {
        return apiError("File not found", 404);
      }
      return NextResponse.redirect(url, 302);
    }

    const uploadDir = getUploadDir();
    const filePath = path.resolve(uploadDir, name);

    // Defense in depth: the resolved path must stay inside the upload dir.
    // Lower-cased comparison keeps Windows (case-insensitive FS) from
    // treating `C:/uploadsile` and `c:᫕adsile` differently.
    const dirWithSep = uploadDir.endsWith(path.sep) ? uploadDir : uploadDir + path.sep;
    if (!filePath.toLowerCase().startsWith(dirWithSep.toLowerCase())) {
      return apiError("Invalid file name", 400);
    }

    const bytes = await readImageFile(name);

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentTypeForName(name),
        // Uploaded files are immutable — cache aggressively.
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return apiError("File not found", 404);
  }
}