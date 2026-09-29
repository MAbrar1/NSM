import { create } from "zustand";
import { generateId } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   TOAST STORE
   Global in-app notifications. Replace alert() with toast() for
   a consistent, non-blocking UX.

   Contract:
   • Bounded — one incoming toast caps the stack at MAX_TOASTS; a flood
     can never runaway the DOM.
   • Same-variant coalescing — repeated identical titles replace the
     existing card instead of stacking; progress-like updates stay one
     card.
   • Sticky-aware — a sticky toast (duration 0) survives the cap and is
     never auto-dismissed.
   • Stacking order — newest sits on top so the user always sees the
     latest thing first.
   • Deterministic ids — collisions within the same tick cannot happen.
   ═══════════════════════════════════════════════════════════════ */

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration?: number; // ms, 0 = sticky (defaults to DEFAULT_DURATION)
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const MAX_TOASTS = 5;
const DEFAULT_DURATION = 4000;

/** Key used to coalesce same-variant, same-title toasts into one card. */
function coalesceKey(t: Omit<Toast, "id">): string {
  return `${t.variant}\x00${t.title}`;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (toast) => {
    const id = generateId("toast");
    const duration = toast.duration ?? DEFAULT_DURATION;
    const item: Toast = { ...toast, duration, id };
    const key = coalesceKey(toast);

    // Schedule auto-dismiss for non-sticky cards.
    // Schedule auto-dismiss for non-sticky cards.
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration);
    }

    set((_state) => {
      const byKey = new Map<string, string>();
      for (const t of _state.toasts) byKey.set(coalesceKey(t), t.id);

      const existingId = byKey.get(key);
      if (existingId) {
        // Replace the existing card in place so the stack does not grow.
        return {
          toasts: _state.toasts.map((t) =>
            t.id === existingId ? { ...t, title: item.title, description: item.description } : t
          ),
        };
      }

      const sticky = item.duration === 0;
      const next: Toast[] = [item, ..._state.toasts];

      if (!sticky && next.length > MAX_TOASTS) {
        // Drop the oldest non-sticky card to honour the cap.
        const oldestNonSticky = next.find((t) => t.duration !== 0);
        const trimmed = oldestNonSticky
          ? next.filter((t) => t.id !== oldestNonSticky!.id)
          : next;
        const out = trimmed.slice(0, MAX_TOASTS);
        return { toasts: out };
      }

      return { toasts: next };
    });
    return id;
  },

  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clear: () => set({ toasts: [] }),
}));

/* ─── Convenience helpers ───────────────────────────────────── */

export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: "success" }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: "error" }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: "warning" }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: "info" }),
};