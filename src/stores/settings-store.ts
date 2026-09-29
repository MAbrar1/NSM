import { create } from "zustand";
import { persist } from "zustand/middleware";

/* ═══════════════════════════════════════════════════════════════
   SETTINGS STORE
   Lightweight client cache of display preferences. Two kinds:
   • store-wide: display currency (synced from /api/settings/currency)
   • per-user: dashboard date-range + warehouse scope (persisted to
     localStorage under a per-user key so each user's dashboard comes
     back exactly as they left it — see hydrateDashboardPrefs)
   Deliberately kept separate from the admin Settings page, which
   manages the full settings document via /api/settings.
   ═══════════════════════════════════════════════════════════════ */

interface SettingsState {
  /** ISO 4217 code applied as the formatCurrency default app-wide. */
  currency: string;
  /** True once /api/settings/currency has answered (or failed). */
  currencyLoaded: boolean;
  /** Per-browser display currency (null = follow the store's base). */
  displayCurrency: string | null;
  setCurrency: (currency: string) => void;
  setDisplayCurrency: (code: string | null) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  currency: "",
  currencyLoaded: false,
  displayCurrency: null,
  setCurrency: (currency) => set({ currency, currencyLoaded: true }),
  setDisplayCurrency: (code) => set({ displayCurrency: code }),
}));

/* ─── Per-user dashboard preferences ───
   Persisted per user id: dashboard date-range preset + warehouse
   scope. Survives reloads and sign-outs, and different users on the
   same browser keep independent preferences. */

export type RangePreset = "today" | "7d" | "30d" | "mtd";

interface DashboardPrefs {
  /** Selected dashboard range preset (null = default "today"). */
  rangePreset: RangePreset | null;
  /** Selected warehouse scope (null = all warehouses). */
  warehouseScope: string | null;
}

interface DashboardPrefsActions {
  setRangePreset: (preset: RangePreset) => void;
  setWarehouseScope: (warehouseId: string | null) => void;
  /** Load the named user's persisted prefs into the live state. */
  hydrateDashboardPrefs: (userId: string) => void;
}

type DashboardPrefsState = DashboardPrefs & DashboardPrefsActions;

const DEFAULT_PREFS: DashboardPrefs = { rangePreset: null, warehouseScope: null };

export const useDashboardPrefsStore = create<DashboardPrefsState>()(
  persist(
    (set, get) => ({
      rangePreset: null,
      warehouseScope: null,

      setRangePreset: (preset) => set({ rangePreset: preset }),
      setWarehouseScope: (warehouseId) => set({ warehouseScope: warehouseId }),

      hydrateDashboardPrefs: (userId) => {
        const withMap = get() as DashboardPrefsState & { _perUser?: Record<string, DashboardPrefs> };
        const saved = withMap._perUser?.[userId];
        set(saved ?? DEFAULT_PREFS);
        if (!saved) {
          // First session for this user — seed their bucket so any
          // immediate writes have a map to land in.
          commitDashboardPrefs(userId, DEFAULT_PREFS);
        }
      },
    }),
    {
      name: "elite-pos-dashboard-prefs",
      // Persist the live state AND the per-user map so re-login restores
      // each user's own preferences rather than the last writer's.
      partialize: (state) => ({
        rangePreset: state.rangePreset,
        warehouseScope: state.warehouseScope,
        _perUser: (state as DashboardPrefsState & { _perUser?: Record<string, DashboardPrefs> })._perUser,
      }),
    }
  )
);

/* Ensure writes also land in the per-user bucket so switching users
   never loses anyone's preferences. Simple post-persist hooking via
   store.subscribe — zustand's persist middleware serializes the
   partialized state on every change, so keeping _perUser inside the
   persisted state (above) is sufficient. */
export function commitDashboardPrefs(userId: string, prefs: DashboardPrefs): void {
  // Read-modify-write the per-user map through the store's set.
  useDashboardPrefsStore.setState((state) => {
    const withMap = state as DashboardPrefsState & { _perUser?: Record<string, DashboardPrefs> };
    const map = { ...(withMap._perUser ?? {}) };
    map[userId] = prefs;
    return { _perUser: map } as Partial<DashboardPrefsState>;
  });
}
