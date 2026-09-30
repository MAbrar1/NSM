import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/api-errors";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import {
  deleteImageFile,
  isManagedFileUrl,
  MAX_IMAGES_PER_PRODUCT,
  parseImageGallery,
  saveImageFile,
} from "@/lib/files/uploads";

/* ═══════════════════════════════════════════════════════════════
   PRODUCT IMAGE API
   POST /api/products/:id/image — Upload an image (multipart, field
        "image"). Files are written to the uploads directory (see
        lib/uploads.ts) and served by GET /api/files/:name; the DB only
        stores the URL. Appends to the gallery and makes the new image
        the primary thumbnail when the gallery is empty.
   PUT  /api/products/:id/image — Persist the ordered gallery (JSON
        body { images: string[] }) after reorder/removal. Files removed
        from this product's gallery are deleted from disk.

   Legacy base64 data-URL images remain fully supported — they are
   skipped by file cleanup and keep rendering as-is.
   ═══════════════════════════════════════════════════════════════ */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Image mutations are product edits — require the same permission
    const { response } = await requirePermission("products:edit");
    if (response) return response;

    const { id } = await params;
    const formData = await request.formData();
    const file = formData.get("image") as File | null;

    if (!file) {
      return apiError("No image provided", 400);
    }

    // Validate + persist to disk (throws with a user-facing message).
    let dataUrl: string;
    try {
      dataUrl = await saveImageFile(file);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Upload failed" },
        { status: 400 }
      );
    }

    const existing = await db.product.findUnique({
      where: { id },
      select: { id: true, images: true, imageUrl: true },
    });
    if (!existing) {
      return apiError("Product not found", 404);
    }

    const gallery = parseImageGallery(existing.images);
    // Cap the gallery so a product can't grow unbounded
    if (gallery.length >= MAX_IMAGES_PER_PRODUCT) {
      return NextResponse.json(
        { error: `Maximum ${MAX_IMAGES_PER_PRODUCT} images per product` },
        { status: 400 }
      );
    }
    gallery.push(dataUrl);

    const product = await db.product.update({
      where: { id },
      data: {
        // Cover invariant: the FIRST gallery image is always the primary
        // thumbnail (null when the gallery is empty). Never keep a stale
        // cover that the gallery no longer references.
        imageUrl: gallery[0] ?? null,
        images: JSON.stringify(gallery),
      },
      select: { id: true, name: true, imageUrl: true, images: true },
    });

    return NextResponse.json({
      product: { ...product, images: parseImageGallery(product.images) },
      imageUrl: dataUrl,
      message: "Image uploaded successfully",
    });
  } catch (error) {
    console.error("[PRODUCT_IMAGE]", error);
    return apiError("Internal server error", 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { response } = await requirePermission("products:edit");
    if (response) return response;

    const { id } = await params;
    const body = (await request.json()) as { images?: unknown };

    if (!Array.isArray(body.images)) {
      return apiError("images array is required", 400);
    }

    const images = (body.images as unknown[]).filter(
      (u): u is string => typeof u === "string"
    );
    if (images.length > MAX_IMAGES_PER_PRODUCT) {
      return NextResponse.json(
        { error: `Maximum ${MAX_IMAGES_PER_PRODUCT} images per product` },
        { status: 400 }
      );
    }

    const existing = await db.product.findUnique({
      where: { id },
      select: { id: true, imageUrl: true, images: true },
    });
    if (!existing) {
      return apiError("Product not found", 404);
    }

    // Remove files this product stopped referencing (only OUR managed
    // URLs — legacy data URLs and foreign URLs are never touched).
    const newSet = new Set(images);
    const previous = parseImageGallery(existing.images);
    await Promise.all(
      previous
        .filter((url) => isManagedFileUrl(url) && !newSet.has(url))
        .map((url) => deleteImageFile(url).catch(() => undefined))
    );

    const product = await db.product.update({
      where: { id },
      data: {
        // Cover invariant (see POST): cover == first gallery entry;
        // emptying the gallery clears the cover too.
        imageUrl: images[0] ?? null,
        images: JSON.stringify(images),
      },
      select: { id: true, name: true, imageUrl: true, images: true },
    });

    return NextResponse.json({
      product: { ...product, images: parseImageGallery(product.images) },
      message: "Gallery saved",
    });
  } catch (error) {
    console.error("[PRODUCT_IMAGE_PUT]", error);
    return apiError("Internal server error", 500);
  }
}