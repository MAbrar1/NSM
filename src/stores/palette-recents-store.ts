import { create } from "zustand";
import { persist } from "zustand/middleware";

/* ═══════════════════════════════════════════════════════════════
   COMMAND-PALETTE RECENTS (roaming)
   The ⌘K palette's "Recent" row: the destinations THIS user actually
   visits, most recent first. Persisted per user — localStorage for
   instant/offline access (same per-user bucket pattern as the
   dashboard prefs store) AND server-side via /api/palette-recents so
   the list follows the user across browsers and devices.

   Contract:
   • capped at MAX_RECENTS (5) — a recents row longer than the quick
     actions row it sits above would be noise, not a shortcut;
   • deduped by href — revisiting bumps, never duplicates;
   • hydrate/commit split mirrors useDashboardPrefsStore so the write
     triggered by hydration itself cannot clobber the just-loaded user;
   • server sync is fire-and-forget: the palette never waits on the
     network. localStorage renders immediately, the server list
     merges in when the pull resolves, and a failed push only flips
     `serverSync` to "error" — the local list stays authoritative
     until the next successful sync.
   ═══════════════════════════════════════════════════════════════ */

export interface PaletteRecent {
  href: string;
  label: string;
  icon: string;
}

export const MAX_RECENTS = 5;

type PerUserMap = Record<string, PaletteRecent[]>;

export interface PaletteRecentsState {
  /** Live recents for the signed-in user (empty until hydrated). */
  recents: PaletteRecent[];
  /** Server round-trip status for the signed-in user's list. */
  serverSync: "idle" | "saving" | "saved" | "error";
  /** Swap in the named user's persisted list (or start empty), then
      pull their roaming list from the server in the background. */
  hydratePaletteRecents: (userId: string) => void;
}

function perUserOf(state: PaletteRecentsState): PerUserMap {
  return (state as PaletteRecentsState & { _perUser?: PerUserMap })._perUser ?? {};
}

/** Shape-guard for entries from the network or persisted storage —
    a malformed entry is dropped, never rendered or re-pushed. */
function sanitizeRecents(raw: unknown): PaletteRecent[] {
  if (!Array.isArray(raw)) return [];
  const out: PaletteRecent[] = [];
  for (const e of raw) {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as PaletteRecent).href === "string" &&
      (e as PaletteRecent).href.length > 0 &&
      typeof (e as PaletteRecent).label === "string" &&
      typeof (e as PaletteRecent).icon === "string"
    ) {
      out.push({ href: (e as PaletteRecent).href, label: (e as PaletteRecent).label, icon: (e as PaletteRecent).icon });
    }
  }
  return out;
}

/** Dedupe by href (first occurrence wins — callers pass newest
    first) and cap at MAX_RECENTS. */
function dedupeByHref(entries: PaletteRecent[]): PaletteRecent[] {
  const seen = new Set<string>();
  const out: PaletteRecent[] = [];
  for (const e of entries) {
    if (seen.has(e.href)) continue;
    seen.add(e.href);
    out.push(e);
  }
  return out.slice(0, MAX_RECENTS);
}

export const usePaletteRecentsStore = create<PaletteRecentsState>()(
  persist(
    (set, get) => ({
      recents: [],
      serverSync: "idle",

      hydratePaletteRecents: (userId) => {
        currentUserId = userId;
        ++syncGeneration;
        set({ recents: perUserOf(get())[userId] ?? [], serverSync: "idle" });
        void pullFromServer(userId);
      },
    }),
    {
      name: "elite-pos-palette-recents",
      partialize: (state) => ({
        recents: state.recents,
        _perUser: perUserOf(state),
      }),
    }
  )
);

/* ─── Server sync (roaming) ─────────────────────────────────────── */

/** The user hydrate() last saw — pushes for a user who is no longer
    the session user are dropped, so a stale flush can never land in
    another user's row (the API scopes writes by session anyway). */
let currentUserId: string | null = null;
/** Invalidated on every hydrate so a pull that outlives its user
    cannot write another user's list into live state. */
let syncGeneration = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Pull the user's roaming list and merge it into local state.
 * Merge policy: union, deduped, LOCAL wins on href collision (a local
 * entry is either identical to the server's or a newer un-synced
 * visit), local-only entries stay so offline visits are never lost.
 * The merged list is written back to the per-user bucket so it is
 * cached for the next offline start.
 */
async function pullFromServer(userId: string): Promise<void> {
  const gen = syncGeneration;
  try {
    const res = await fetch("/api/palette-recents", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { recents?: unknown };
    if (gen !== syncGeneration) return; // user switched mid-flight
    const server = sanitizeRecents(data.recents);
    usePaletteRecentsStore.setState((state) => {
      const local = perUserOf(state)[userId] ?? [];
      const merged = dedupeByHref([...local, ...server]);
      if (
        merged.length === local.length &&
        merged.every((r, i) => r === local[i] || (r.href === local[i]?.href && r.label === local[i]?.label && r.icon === local[i]?.icon))
      ) {
        return {}; // nothing new — don't touch state or storage
      }
      const map = { ...perUserOf(state), [userId]: merged };
      return { recents: merged, _perUser: map } as Partial<PaletteRecentsState>;
    });
    // If the merge carries entries the server lacks (offline visits),
    // push them up so this browser converges with the server.
    void scheduleServerPush(userId, 0);
  } catch {
    /* offline — localStorage remains the truth; nothing to do */
  }
}

/**
 * Queue a debounced full-list PUT for `userId`. Coalesces rapid
 * navigation bursts into one request; the flush is dropped if the
 * session user changed meanwhile.
 */
function scheduleServerPush(userId: string, delayMs = 800): void {
  if (typeof window === "undefined") return; // SSR / non-browser: skip silently
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushToServer(userId);
  }, delayMs);
}

async function pushToServer(userId: string): Promise<void> {
  if (userId !== currentUserId) return;
  const list = perUserOf(usePaletteRecentsStore.getState())[userId];
  if (!list) return;
  usePaletteRecentsStore.setState({ serverSync: "saving" });
  try {
    const res = await fetch("/api/palette-recents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recents: list }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    usePaletteRecentsStore.setState({ serverSync: "saved" });
  } catch {
    usePaletteRecentsStore.setState({ serverSync: "error" });
  }
}

/**
 * Module-level hydrate twin for non-hook callers (tests, scripts):
 * identical to the store action, exported for direct import.
 */
export function hydratePaletteRecents(userId: string): void {
  usePaletteRecentsStore.getState().hydratePaletteRecents(userId);
}

/** Test/teardown helper: flush any pending debounced push now. */
export function flushPaletteSync(): Promise<void> {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (currentUserId) return pushToServer(currentUserId).then(() => undefined);
  }
  return Promise.resolve();
}

/**
 * Record a navigation. Dedupe by href (existing entry moves to the
 * front with fresh metadata — labels/icons can change), cap the list,
 * then persist: per-user localStorage (optimistic, synchronous) and a
 * debounced server push so the list roams.
 * `userId` may be null (pre-session) — then only the live state moves,
 * nothing persists, so an anonymous open/close cycle leaves no trace.
 */
export function pushPaletteRecent(
  userId: string | null,
  entry: PaletteRecent
): void {
  // Derive from the USER'S OWN bucket (not the live list) so that —
  // even in a hypothetical missed-hydrate window — one user's push
  // can never fold another user's destinations into their bucket.
  // Anonymous (null userId) pushes ride the live list only.
  usePaletteRecentsStore.setState((state) => {
    const list = userId ? (perUserOf(state)[userId] ?? []) : state.recents;
    const bumped = dedupeByHref([entry, ...list]);
    if (!userId) return { recents: bumped };
    return {
      recents: bumped,
      _perUser: { ...perUserOf(state), [userId]: bumped },
    } as Partial<PaletteRecentsState>;
  });
  if (userId) scheduleServerPush(userId);
}
