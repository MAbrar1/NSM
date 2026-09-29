"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/providers/i18n-provider";
import { usePopoverMenu } from "@/hooks/use-popover-menu";

/* ═══════════════════════════════════════════════════════════════
   THEME PROVIDER
   Manages dark/light/system theme with localStorage persistence.
   Applies the `dark` class to <html> and respects system preference.
   ═══════════════════════════════════════════════════════════════ */

export type Theme = "light" | "dark" | "system" | "golden";

export type ResolvedTheme = "light" | "dark" | "golden";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>("light");
  const [mounted, setMounted] = React.useState(false);

  // Resolve the actual theme based on scheme + system preference.
  // "golden" is a first-class surface, not a tint of light Neu.
  const resolveTheme = React.useCallback((t: Theme): ResolvedTheme => {
    if (t === "system") {
      if (typeof window !== "undefined" && window.matchMedia) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      return "light";
    }
    return t as ResolvedTheme;
  }, []);

  // Initialize from localStorage
  React.useEffect(() => {
    const saved = localStorage.getItem("elite-pos-theme") as Theme | null;
    // "golden" MUST be in this allow-list: omitting it silently reset the
    // saved Golden choice to the system theme on every reload.
    if (saved && (saved === "light" || saved === "dark" || saved === "golden" || saved === "system")) {
      setThemeState(saved);
    }
    setMounted(true);
  }, []);

  // Apply theme to <html> whenever it changes.
  // Class contract:
  //   .light        → Neu light
  //   .dark         → Neu dark
  //   .golden       → Golden light
  //   .golden.dark  → Golden dark (CSS handles the token re-derivation)
  React.useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    const root = document.documentElement;
    root.classList.remove("light", "dark", "golden");
    if (resolved === "golden") {
      root.classList.add("golden");
    } else {
      root.classList.add(resolved);
    }
    root.setAttribute("data-theme", resolved);
  }, [theme, resolveTheme]);

  // Listen for system preference changes when in "system" mode.
  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const resolved = resolveTheme("system");
      setResolvedTheme(resolved);
      const root = document.documentElement;
      root.classList.remove("light", "dark", "golden");
      root.classList.add(resolved);
      root.setAttribute("data-theme", resolved);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme, resolveTheme]);

  const setTheme = React.useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem("elite-pos-theme", newTheme);
  }, []);

  // Prevent flash of wrong theme
  const style = mounted
    ? undefined
    : { visibility: "hidden" as const };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      <div style={style}>{children}</div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return React.useContext(ThemeContext);
}

/* ═══════════════════════════════════════════════════════════════
   THEME TOGGLE
   A single-choice menu, so it is marked up as one: `role="menu"`
   with `menuitemradio` children carrying `aria-checked`, which is
   the only thing that tells a screen reader which scheme is active
   (the check mark is a visual duplicate of that state, not the
   state itself).
   ═══════════════════════════════════════════════════════════════ */

/** Inline SVG only — the three emoji this used to render (☀️ 🌙 💻) were
    the last icon-font/emoji glyphs in the app. Golden wears the Heroicons
    "sparkles" mark: three four-point stars, the premium finish the theme
    is named for. */
function ThemeIcon({ theme, className }: { theme: Theme; className?: string }) {
  if (theme === "golden") {
    return (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
        />
      </svg>
    );
  }
  const d =
    theme === "light"
      ? "M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
      : theme === "dark"
        ? "M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
        : "M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25";
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  usePopoverMenu({ open, triggerRef, panelRef, onClose: () => setOpen(false) });

  const options: Array<{ value: Theme; label: string }> = [
    { value: "light", label: t("common.schemeLight") },
    { value: "dark", label: t("common.schemeDark") },
    { value: "golden", label: t("common.schemeGolden") },
    { value: "system", label: t("common.schemeSystem") },
  ];

  const currentIndex = options.findIndex((o) => o.value === theme);
  const current = currentIndex >= 0 ? options[currentIndex]! : options[3]!;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${t("header.toggleTheme")} (${current.label})`}
        title={t("header.toggleTheme")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "neu-btn neu-btn-icon-sm neu-focus",
          open ? "bg-neu-sunken text-neu-primary" : "text-neu-muted hover:bg-neu-sunken hover:text-neu-primary"
        )}
      >
        <ThemeIcon theme={theme} className="h-4 w-4" />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={t("header.toggleTheme")}
          className="neu-elevated absolute end-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-xl border border-neu-hairline animate-scale-in"
        >
          {options.map((opt) => {
            const checked = theme === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => {
                  setTheme(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "neu-focus flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors",
                  checked
                    ? "neu-inset-sm bg-neu-accent-wash font-semibold text-neu-accent-ink-strong"
                    : "text-neu-primary hover:bg-neu-sunken"
                )}
              >
                <ThemeIcon theme={opt.value} className="h-4 w-4" />
                {opt.label}
                {checked && (
                  <svg className="ms-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
