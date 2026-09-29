import { create } from "zustand";
import { persist } from "zustand/middleware";

/* ═══════════════════════════════════════════════════════════════
   UI STORE
   Global UI state: sidebar, theme, modals, toasts, etc.
   ═══════════════════════════════════════════════════════════════ */

interface UIState {
  // Sidebar
  sidebarCollapsed: boolean;
  sidebarMobileOpen: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarMobileOpen: (open: boolean) => void;

  // Theme
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;

  // Global Search
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;

  // Active workspace (multi-store support)
  activeWarehouseId: string | null;
  setActiveWarehouseId: (id: string | null) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // Sidebar defaults
      sidebarCollapsed: false,
      sidebarMobileOpen: false,
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarMobileOpen: (open) => set({ sidebarMobileOpen: open }),

      // Theme
      theme: "light",
      setTheme: (theme) => set({ theme }),

      // Search
      searchOpen: false,
      setSearchOpen: (open) => set({ searchOpen: open }),

      // Warehouse
      activeWarehouseId: null,
      setActiveWarehouseId: (id) => set({ activeWarehouseId: id }),
    }),
    {
      name: "elite-pos-ui",
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        theme: state.theme,
        activeWarehouseId: state.activeWarehouseId,
      }),
    }
  )
);
