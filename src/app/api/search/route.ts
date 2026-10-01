import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/api/api-auth";
import { parsePagination } from "@/lib/api/pagination";
import { formatDate } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   GLOBAL SEARCH API
   GET /api/search?q=... — Unified search across all entities.
   Returns grouped results by type for the global search modal.
   ═══════════════════════════════════════════════════════════════ */

interface SearchResult {
  type: "product" | "customer" | "order" | "supplier" | "purchase_order";
  id: string;
  title: string;
  subtitle: string;
  href: string;
  badge?: string;
  badgeVariant?: "success" | "warning" | "danger" | "info" | "default";
}

export async function GET(request: NextRequest) {
  try {
    const { response } = await requirePermission();
    if (response) return response;

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") ?? "";
    const limit = parsePagination(searchParams, {
      defaultPageSize: 20,
      maxPageSize: 50,
      pageSizeParam: "limit",
    }).pageSize;

    if (!query || query.length < 1) {
      return NextResponse.json({ results: [], groups: {} });
    }

    const perTypeLimit = Math.ceil(limit / 5);

    // Parallel searches across all entity types
    const [products, customers, orders, suppliers, purchaseOrders] = await Promise.all([
      // Products — search by name, SKU, barcode
      db.product.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: query } },
            { sku: { contains: query } },
            { barcode: { contains: query } },
          ],
        },
        select: {
          id: true,
          name: true,
          sku: true,
          status: true,
          category: { select: { name: true } },
        },
        take: perTypeLimit,
        orderBy: [{ name: "asc" }],
      }),

      // Customers — search by name, email, phone
      db.customer.findMany({
        where: {
          isActive: true,
          OR: [
            { name: { contains: query } },
            { email: { contains: query } },
            { phone: { contains: query } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          orderCount: true,
        },
        take: perTypeLimit,
        orderBy: { name: "asc" },
      }),

      // Orders — search by order number, customer name
      db.order.findMany({
        where: {
          OR: [
            { orderNumber: { contains: query } },
            { customer: { name: { contains: query } } },
            { user: { name: { contains: query } } },
          ],
        },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          createdAt: true,
          customer: { select: { name: true } },
        },
        take: perTypeLimit,
        orderBy: { createdAt: "desc" },
      }),

      // Suppliers — search by name, email, phone
      db.supplier.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: query } },
            { email: { contains: query } },
            { phone: { contains: query } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
        take: perTypeLimit,
        orderBy: { name: "asc" },
      }),

      // Purchase Orders — search by order number, supplier name
      db.purchaseOrder.findMany({
        where: {
          OR: [
            { orderNumber: { contains: query } },
            { supplier: { name: { contains: query } } },
          ],
        },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          supplier: { select: { name: true } },
        },
        take: perTypeLimit,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Map results into unified format
    const results: SearchResult[] = [];

    for (const p of products) {
      results.push({
        type: "product",
        id: p.id,
        title: p.name,
        subtitle: `${p.sku} · ${p.category.name}`,
        href: `/products?search=${encodeURIComponent(p.sku)}`,
        badge: p.status,
        badgeVariant: p.status === "active" ? "success" : p.status === "discontinued" ? "danger" : "warning",
      });
    }

    for (const c of customers) {
      results.push({
        type: "customer",
        id: c.id,
        title: c.name,
        subtitle: [c.email, c.phone].filter(Boolean).join(" · ") || `${c.orderCount} orders`,
        href: `/customers?search=${encodeURIComponent(c.name)}`,
      });
    }

    for (const o of orders) {
      results.push({
        type: "order",
        id: o.id,
        title: o.orderNumber,
        subtitle: `${o.customer?.name ?? "Walk-in"} · ${formatDate(o.createdAt)}`,
        href: `/orders?search=${encodeURIComponent(o.orderNumber)}`,
        badge: o.status,
        badgeVariant: o.status === "completed" ? "success" : o.status === "cancelled" || o.status === "refunded" ? "danger" : "info",
      });
    }

    for (const s of suppliers) {
      results.push({
        type: "supplier",
        id: s.id,
        title: s.name,
        subtitle: [s.email, s.phone].filter(Boolean).join(" · ") || "Supplier",
        href: `/suppliers?search=${encodeURIComponent(s.name)}`,
      });
    }

    for (const po of purchaseOrders) {
      results.push({
        type: "purchase_order",
        id: po.id,
        title: po.orderNumber,
        subtitle: `${po.supplier.name} · ${po.status}`,
        href: `/purchase-orders?search=${encodeURIComponent(po.orderNumber)}`,
        badge: po.status,
        badgeVariant: po.status === "received" ? "success" : po.status === "cancelled" ? "danger" : "info",
      });
    }

    // Group by type for faceted display
    const groups: Record<string, SearchResult[]> = {};
    for (const r of results) {
      const key = r.type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }

    return NextResponse.json({ results, groups });
  } catch (error) {
    console.error("[GLOBAL_SEARCH]", error);
    return NextResponse.json({ results: [], groups: {} }, { status: 500 });
  }
}
