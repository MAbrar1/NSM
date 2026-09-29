import { create } from "zustand";
import { persist } from "zustand/middleware";

/* ═══════════════════════════════════════════════════════════════
   WAREHOUSE STORE
   Tracks the currently selected warehouse across the app.
   Persists to localStorage so the selection survives refresh.
   ═══════════════════════════════════════════════════════════════ */

interface WarehouseInfo {
  id: string;
  name: string;
  code: string;
  isDefault: boolean;
}

interface WarehouseState {
  warehouses: WarehouseInfo[];
  selectedWarehouseId: string | null;
  setWarehouses: (warehouses: WarehouseInfo[]) => void;
  selectWarehouse: (id: string) => void;
  getSelectedWarehouse: () => WarehouseInfo | null;
}

export const useWarehouseStore = create<WarehouseState>()(
  persist(
    (set, get) => ({
      warehouses: [],
      selectedWarehouseId: null,

      setWarehouses: (warehouses) => {
        set({ warehouses });
        // Auto-select default if none selected
        if (!get().selectedWarehouseId && warehouses.length > 0) {
          const defaultWh = warehouses.find((w) => w.isDefault) ?? warehouses[0];
          if (defaultWh) {
            set({ selectedWarehouseId: defaultWh.id });
          }
        }
      },

      selectWarehouse: (id) => set({ selectedWarehouseId: id }),

      getSelectedWarehouse: () => {
        const { warehouses, selectedWarehouseId } = get();
        return warehouses.find((w) => w.id === selectedWarehouseId) ?? warehouses[0] ?? null;
      },
    }),
    {
      name: "elite-pos-warehouse",
      partialize: (state) => ({
        selectedWarehouseId: state.selectedWarehouseId,
      }),
    }
  )
);
