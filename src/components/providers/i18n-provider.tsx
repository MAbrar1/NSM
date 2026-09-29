"use client";

import * as React from "react";
import en from "@/i18n/locales/en.json";
import ur from "@/i18n/locales/ur.json";

/* ═══════════════════════════════════════════════════════════════
   i18n — Internationalization Context
   Supports English and Urdu (Pakistan) with RTL layout.
   ═══════════════════════════════════════════════════════════════ */

export type Locale = "en" | "ur";

type TranslationDict = Record<string, unknown>;

const translations: Record<Locale, TranslationDict> = {
  en: en as TranslationDict,
  ur: ur as TranslationDict,
};

interface I18nContextValue {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  tKey: string; // For React keys that need to change with locale
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

/* ─── Dot notation accessor ─────────────────────────────────── */

function getNestedValue(obj: TranslationDict, path: string): string {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current && typeof current === "object" && key in (current as TranslationDict)) {
      current = (current as TranslationDict)[key];
    } else {
      return path; // Return key if not found
    }
  }
  return typeof current === "string" ? current : path;
}

/* ─── Provider ──────────────────────────────────────────────── */

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>("en");

  // Initialize from localStorage
  React.useEffect(() => {
    const saved = localStorage.getItem("elite-pos-locale") as Locale | null;
    if (saved && (saved === "en" || saved === "ur")) {
      setLocaleState(saved);
      document.documentElement.dir = saved === "ur" ? "rtl" : "ltr";
      document.documentElement.lang = saved === "ur" ? "ur" : "en";
    }
  }, []);

  const setLocale = React.useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem("elite-pos-locale", newLocale);
    document.documentElement.dir = newLocale === "ur" ? "rtl" : "ltr";
    document.documentElement.lang = newLocale === "ur" ? "ur" : "en";
  }, []);

  const t = React.useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const raw = getNestedValue(translations[locale], key);
      if (!params) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name) =>
        name in params ? String(params[name]) : m
      );
    },
    [locale]
  );

  const dir: "ltr" | "rtl" = locale === "ur" ? "rtl" : "ltr";

  const value = React.useMemo(
    () => ({ locale, dir, setLocale, t, tKey: locale }),
    [locale, dir, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/* ─── Hook ──────────────────────────────────────────────────── */

export function useI18n() {
  const context = React.useContext(I18nContext);
  if (!context) {
    // Fallback for when provider is not available
    return {
      locale: "en" as Locale,
      dir: "ltr" as const,
      setLocale: () => {},
      t: (key: string, params?: Record<string, string | number>) => {
        const raw = getNestedValue(translations["en"], key);
        if (!params) return raw;
        return raw.replace(/\{(\w+)\}/g, (m, name) =>
          name in params ? String(params[name]) : m
        );
      },
      tKey: "en",
    };
  }
  return context;
}