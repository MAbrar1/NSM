import { create } from "zustand";
import { persist } from "zustand/middleware";

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATION STORE — client-side read/unread acknowledgement
   Alerts are DERIVED (recomputed from live stock on every scan), so
   there is nothing to persist server-side and no delivery record to
   model. What a real notification surface still owes the user is a
   "what's new since I last looked" signal. That is per-user and
   per-browser, so it lives here, keyed by user id — a shared register
   does not leak one cashier's read state onto the next user.

   Bounded: only the most recent `SEEN_LIMIT` ids are kept per user,
   so a long-lived store cannot grow without limit.
   ═══════════════════════════════════════════════════════════════ */

const SEEN_LIMIT = 500;

interface NotificationState {
  /** userId → alert ids the user has acknowledged. */
  seen: Record<string, string[]>;
  /** Mark every id in the feed as seen (called when the panel is opened
   *  with the feed visible, and by the explicit "mark all read" action). */
  markSeen: (userId: string, ids: string[]) => void;
  /** Forget a user's read state (used on sign-out of that user). */
  clearSeen: (userId: string) => void;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      seen: {},

      markSeen: (userId, ids) =>
        set((state) => {
          if (!userId || ids.length === 0) return state;
          const previous = state.seen[userId] ?? [];
          const merged = [...previous];
          const known = new Set(previous);
          for (const id of ids) {
            if (!known.has(id)) {
              known.add(id);
              merged.push(id);
            }
          }
          return {
            seen: {
              ...state.seen,
              [userId]: merged.slice(-SEEN_LIMIT),
            },
          };
        }),

      clearSeen: (userId) =>
        set((state) => {
          if (!state.seen[userId]) return state;
          const next = { ...state.seen };
          delete next[userId];
          return { seen: next };
        }),
    }),
    {
      name: "elite-pos-notifications",
      partialize: (state) => ({ seen: state.seen }),
    }
  )
);

/** Already-seen id set for a user as a plain Set (stable for useMemo). */
export function seenSetFor(seen: Record<string, string[]>, userId: string | null): Set<string> {
  if (!userId) return new Set();
  return new Set(seen[userId] ?? []);
}
