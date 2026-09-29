import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartItem, ID, Currency } from "@/types";
import { generateId } from "@/lib/utils";
import {
  calculateCartTotals as computeTotals,
  refreshLineTotals,
} from "@/lib/cart-math";

/* ═══════════════════════════════════════════════════════════════
   CART STORE
   Manages the POS shopping cart with real-time calculations.
   Persists across page refreshes for reliable checkout flow.
   ═══════════════════════════════════════════════════════════════ */

interface CartState {
  items: CartItem[];
  customerId: string | null;
  customerName: string | null;
  taxRate: number;

  // Computed values
  subtotal: Currency;
  taxAmount: Currency;
  discountAmount: Currency;
  total: Currency;
  itemCount: number;

  // Actions
  addItem: (item: Omit<CartItem, "id" | "taxAmount" | "discountAmount" | "total">) => void;
  removeItem: (itemId: ID) => void;
  updateItemQuantity: (itemId: ID, quantity: number) => void;
  updateItemDiscount: (
    itemId: ID,
    discountType: "percentage" | "fixed",
    discountValue: number
  ) => void;
  setTaxRate: (rate: number) => void;
  setCustomer: (customerId: ID | null, customerName: string | null) => void;
  clearCart: () => void;

  // Helpers
  getItemByProductId: (productId: ID, variantId?: ID) => CartItem | undefined;
}

/** Type of the persisted/subscribed totals slice. */
export type CartTotalsSlice = Pick<
  CartState,
  "subtotal" | "taxAmount" | "discountAmount" | "total" | "itemCount"
>;

function calculateCartTotals(items: CartItem[], taxRate: number): CartTotalsSlice {
  return computeTotals(items, taxRate);
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      customerId: null,
      customerName: null,
      taxRate: 0,

      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
      total: 0,
      itemCount: 0,

      addItem: (newItem) => {
        const { items, taxRate } = get();
        const existingIndex = items.findIndex(
          (i) =>
            i.productId === newItem.productId &&
            i.variantId === newItem.variantId
        );

        let updatedItems: CartItem[];

        if (existingIndex >= 0) {
          // Merge: increment quantity of existing item
          updatedItems = items.map((item, idx) =>
            idx === existingIndex
              ? { ...item, quantity: item.quantity + newItem.quantity }
              : item
          );
        } else {
          // Add new item (per-line totals are attached by refreshLineTotals)
          updatedItems = [...items, {
            ...newItem,
            id: generateId("cart"),
            taxAmount: 0,
            discountAmount: 0,
            total: 0,
          } as CartItem];
        }

        // Re-derive every line total so merged/added rows never carry stale
        // totals (this also feeds the checkout payload + receipt lines).
        const enriched = refreshLineTotals(updatedItems, taxRate);
        const totals = calculateCartTotals(enriched, taxRate);
        set({ items: enriched, ...totals });
      },

      removeItem: (itemId) => {
        const { items, taxRate } = get();
        const updatedItems = items.filter((i) => i.id !== itemId);
        const totals = calculateCartTotals(updatedItems, taxRate);
        set({ items: updatedItems, ...totals });
      },

      updateItemQuantity: (itemId, quantity) => {
        const { items, taxRate } = get();

        if (quantity <= 0) {
          const updatedItems = items.filter((i) => i.id !== itemId);
          const totals = calculateCartTotals(updatedItems, taxRate);
          set({ items: updatedItems, ...totals });
          return;
        }

        // Clamp to the stock snapshot captured when the line was added so a
        // stale UI or a fat-finger can never promise more units than exist;
        // checkout still re-validates server-side (this is belt-and-braces).
        const target = items.find((i) => i.id === itemId);
        const cap = target?.stockAvailable;
        const safeQuantity =
          cap != null && cap >= 0 && quantity > cap ? cap : quantity;

        const changed = items.map((item) =>
          item.id === itemId ? { ...item, quantity: safeQuantity } : item
        );
        const enriched = refreshLineTotals(changed, taxRate);
        const totals = calculateCartTotals(enriched, taxRate);
        set({ items: enriched, ...totals });
      },

      updateItemDiscount: (itemId, discountType, discountValue) => {
        const { items, taxRate } = get();
        const changed = items.map((item) =>
          item.id === itemId ? { ...item, discountType, discountValue } : item
        );
        const enriched = refreshLineTotals(changed, taxRate);
        const totals = calculateCartTotals(enriched, taxRate);
        set({ items: enriched, ...totals });
      },

      setTaxRate: (rate) => {
        const { items } = get();
        const totals = calculateCartTotals(items, rate);
        set({ taxRate: rate, ...totals });
      },

      setCustomer: (customerId, customerName) => {
        set({ customerId, customerName });
      },

      clearCart: () => {
        set({
          items: [],
          customerId: null,
          customerName: null,
          subtotal: 0,
          taxAmount: 0,
          discountAmount: 0,
          total: 0,
          itemCount: 0,
        });
      },

      getItemByProductId: (productId, variantId) => {
        return get().items.find(
          (i) => i.productId === productId && i.variantId === variantId
        );
      },
    }),
    {
      name: "elite-pos-cart",
      partialize: (state) => ({
        items: state.items,
        customerId: state.customerId,
        customerName: state.customerName,
        taxRate: state.taxRate,
      }),
      // Totals are intentionally not persisted — recompute them (and refresh
      // every stored line total) as soon as a saved cart rehydrates, so a
      // restored cart shows correct money without any user interaction.
      onRehydrateStorage: () => (state) => {
        if (state && state.items?.length) {
          setTimeout(() => {
            const s = useCartStore.getState();
            if (s.items.length) {
              const enriched = refreshLineTotals(s.items, s.taxRate);
              useCartStore.setState({
                items: enriched,
                ...calculateCartTotals(enriched, s.taxRate),
              });
            }
          }, 0);
        }
      },
    }
  )
);
