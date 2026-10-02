import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/* ═══════════════════════════════════════════════════════════════
   CORE UTILITIES
   Used across the entire application for consistency.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Merge class names with Tailwind CSS conflict resolution.
 * This is the primary utility for combining conditional classes.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* ─── Currency formatting (converted) ───
   The implementation moved to lib/currency-core.ts (with the FX engine
   in lib/currency.ts). Re-exported here so every existing call site
   keeps working unchanged: all pages/components import formatCurrency
   from "@/lib/utils" and pass base-currency cents. When a display
   currency is active, formatters now convert base cents at live rates
   before rendering — see currency-core.ts header for the full design. */
export {
  formatCurrencyBase,
  setCurrencyDefaults,
  getCurrencyDefaults,
  setDisplayCurrency,
  getDisplayCurrency,
  fxRate,
  fxConvertCents,
  registerRateLookup,
  formatCurrency,
  formatCurrencyCompact,
  formatAmount,
} from "@/lib/money/currency-core";

/**
 * Format a number with locale-aware thousand separators.
 */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat("en-US", options).format(value);
}

/**
 * Format a date to a human-readable string.
 */
export function formatDate(
  date: Date | string,
  style: "short" | "medium" | "long" | "full" = "medium"
): string {
  const d = typeof date === "string" ? new Date(date) : date;

  const optionsMap = {
    short: { month: "numeric" as const, day: "numeric" as const, year: "2-digit" as const },
    medium: { month: "short" as const, day: "numeric" as const, year: "numeric" as const },
    long: { month: "long" as const, day: "numeric" as const, year: "numeric" as const },
    full: {
      weekday: "long" as const,
      month: "long" as const,
      day: "numeric" as const,
      year: "numeric" as const,
    },
  };
  const options = optionsMap[style];

  return new Intl.DateTimeFormat("en-US", options).format(d);
}

/**
 * Format a date to time string.
 */
export function formatTime(
  date: Date | string,
  style: "12h" | "24h" = "12h"
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: style === "12h",
  }).format(d);
}

/**
 * Slugify a name for URL-unique columns (brands, categories, products,
 * suppliers): lowercase, non-alphanumerics folded to a single dash,
 * leading/trailing dashes trimmed. Single home for the regex chain
 * that used to be re-typed at every create/update route.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Format a date+time in one string, pinned to the app's display locale
 * (en-US). The single home for what used to be hand-rolled locale-less
 * `toLocaleString` calls — which silently followed each browser's
 * locale instead of the app's format.
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/**
 * Generate a unique ID (for client-side use only).
 */
export function generateId(prefix: string = ""): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}

/**
 * Truncate a string to a maximum length with ellipsis.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + "…";
}

/**
 * Debounce a function call.
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Deep clone an object (simple JSON-based approach).
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Check if a value is empty (null, undefined, empty string, empty array, empty object).
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Sleep for a given number of milliseconds (useful for loading states in dev).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get initials from a full name (e.g., "John Doe" → "JD").
 */
export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase())
    .slice(0, 2)
    .join("");
}

/**
 * Calculate percentage change between two values.
 */
export function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Percentage delta for trend chips — returns `null` when there is
 * nothing to compare against (both periods are zero).
 */
export function percentDelta(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? 100 : null;
  return ((current - previous) / previous) * 100;
}

/**
 * Format a signed percentage for delta chips (e.g. "+12.5%", "-8%").
 */
export function formatPercent(pct: number): string {
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${pct > 0 ? "+" : ""}${str}%`;
}

/**
 * Clamp a number between a minimum and maximum value.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
