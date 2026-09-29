"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/providers/i18n-provider";
import { useCartStore } from "@/stores/cart-store";
import { toast } from "@/stores/toast-store";

/* ═══════════════════════════════════════════════════════════════
   USE RESELL FROM ORDER
   Single source of truth for re-issuing an order as a fresh POS
   sale. Shared by the Orders screen (refunded rows) and the
   Refunds screen detail modal so the behaviour — stock re-check,
   skips, toasts, register navigation — never drifts apart.
   ═══════════════════════════════════════════════════════════════ */

/** Minimal shape of an order line this hook needs (order items carry
 *  productId + sku from the sale, see prisma OrderItem). */
interface ResellSourceLine {
  productId?: string | null;
  sku: string;
  quantity: number;
}

interface ResellSource {
  items: ResellSourceLine[];
}

interface FreshCartLine {
  productId: string;
  productName: string;
  sku: string;
  imageUrl?: string;
  quantity: number;
  unit: string;
  allowFractional?: boolean;
  sellByValue?: boolean;
  unitConversions?: string;
  stockAvailable: number;
  unitPrice: number;
  costPrice: number;
  taxRate: number;
}

export function useResellFromOrder() {
  const { t } = useI18n();
  const router = useRouter();
  const cart = useCartStore();
  const [reselling, setReselling] = React.useState(false);

  const resellFromOrder = React.useCallback(
    async (order: ResellSource) => {
      if (reselling) return;
      setReselling(true);
      try {
        let added = 0;
        let skipped = 0;
        const fresh: FreshCartLine[] = [];

        for (const it of order.items) {
          if (!it.productId || !it.sku) continue;
          // Shared catalog endpoint (/api/products/lookup) — the same
          // rows and stock numbers POS browse/search show, so a re-sell
          // can never resurrect a deleted/archived product or promise
          // stock the POS grid doesn't display.
          const res = await fetch(`/api/products/lookup?ids=${encodeURIComponent(it.productId)}&limit=5`);
          const data = await res.json();
          const prod = (data.products ?? []).find(
            (p: { id: string; sku: string; available: number }) =>
              p.id === it.productId && p.sku === it.sku
          );
          if (!prod || prod.available <= 0) {
            skipped += 1;
            continue;
          }
          fresh.push({
            productId: prod.id,
            productName: prod.name,
            sku: prod.sku,
            imageUrl: prod.imageUrl ?? undefined,
            quantity: Math.min(Math.max(it.quantity, 0.0001), prod.available),
            unit: prod.unit || "pcs",
            allowFractional: prod.allowFractional,
            sellByValue: prod.sellByValue,
            unitConversions: prod.unitConversions ?? undefined,
            stockAvailable: prod.available,
            unitPrice: prod.unitPrice,
            costPrice: prod.costPrice,
            taxRate: prod.taxRate,
          });
          added += 1;
        }

        if (added === 0) {
          toast.error(t("refunds.resellNone"));
          return;
        }

        // Start a fresh sale with the restored items.
        cart.clearCart();
        for (const item of fresh) {
          cart.addItem({
            productId: item.productId,
            productName: item.productName,
            sku: item.sku,
            imageUrl: item.imageUrl,
            quantity: item.quantity,
            unit: item.unit,
            allowFractional: item.allowFractional,
            sellByValue: item.sellByValue,
            unitConversions: item.unitConversions,
            stockAvailable: item.stockAvailable,
            unitPrice: item.unitPrice,
            costPrice: item.costPrice,
            discountType: "percentage",
            discountValue: 0,
            taxRate: item.taxRate,
          });
        }

        toast.success(t("refunds.resellStarted"), `${added} ${t("refunds.itemsAdded")}`);
        if (skipped > 0) {
          setTimeout(
            () => toast.warning(t("refunds.resellSkipped"), `${skipped} ${t("refunds.skippedDetail")}`),
            1200
          );
        }
        setTimeout(() => router.push("/pos"), 500);
      } catch {
        toast.error(t("common.networkError"), t("common.networkErrorDesc"));
      } finally {
        setReselling(false);
      }
    },
    [cart, reselling, router, t]
  );

  return { resellFromOrder, reselling };
}
