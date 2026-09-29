"use client";

import * as React from "react";
import { useI18n } from "@/components/providers/i18n-provider";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   LIVE CLOCK — the header's instrument

   A recessed dial well inside a raised bezel, with the digital
   readout in its own inset window beside it. Every colour is a neu
   token:

   • hands            `--neu-text-primary` — a dial is read, not
                      decorated, so the needles are ink.
   • seconds hand     `--neu-ink-red` (5.43:1 light / 5.29:1 dark).
   • seconds sweep    `--neu-accent-line`, the same AA cyan as every
                      other edge and the focus ring.
   • day / night      `--neu-ink-amber` / `--neu-ink-cyan`.
   • readout + chip   `--neu-text-primary` / `--neu-accent-wash` +
                      `--neu-accent-ink`.

   This replaced the last bespoke palette in the app: an
   `info`→`purple` gradient bezel, a rose `#f43f5e` second hand and
   an `#a855f7` hub, which the audits carried their own exemptions
   for. Nothing on screen is outside the token layer now.

   Two independent timers — 1s for the text, rAF (~20fps) for the
   sweep — so the digits never re-render at 60fps.
   ═══════════════════════════════════════════════════════════════ */

/* ─── Shared design tokens (single source of truth) ─── */

const TWO_DIGIT: Intl.NumberFormatOptions = { minimumIntegerDigits: 2, useGrouping: false };

/** A chip whose own ink is AA on its own wash (5.36:1 light / 6.00:1 dark). */
const CHIP_TEXT = "bg-neu-accent-wash text-neu-accent-ink";

/* ─── Timers ─── */

/**
 * Plain interval clock — one re-render per second for the digital text.
 * Starts at `null` (server + first client render share the same value, so
 * hydration never mismatches on a ticking second) and only begins ticking
 * after mount.
 */
function useNow(intervalMs: number): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * rAF clock (~20fps) — buttery hand sweep, isolated to the analog face.
 * Same mount-gated pattern as `useNow` for hydration safety.
 */
function useSmoothNow(): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last >= 50) {
        setNow(new Date());
        last = t;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return now;
}

/** Locale-digit-aware two-digit segment (e.g. "۰۹" in ur-PK). */
function segment(value: number, locale: string): string {
  return value.toLocaleString(locale, TWO_DIGIT);
}

/* ─── Primitives ─── */

function TimeDigit({ value, localeStr, className }: { value: number; localeStr: string; className?: string }) {
  return (
    <span className={cn("font-mono font-bold tabular-nums tracking-tight text-neu-primary", className)}>
      {segment(value, localeStr)}
    </span>
  );
}

function BlinkColon({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "font-mono font-bold tabular-nums text-neu-primary transition-opacity duration-150",
        on ? "opacity-100" : "opacity-20",
        className
      )}
    >
      :
    </span>
  );
}

function DayNightIcon({ isDay }: { isDay: boolean }) {
  return (
    <>
      {isDay ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </>
      ) : (
        <path d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
      )}
    </>
  );
}

/* ─── Analog face ─── */

/* The dial is decorative: the digital readout states the same time in real
   text, so the SVG is hidden from assistive tech rather than announcing a
   second, coarser copy of it. */
function AnalogFace({ now }: { now: Date }) {
  const h = now.getHours() % 12;
  const m = now.getMinutes();
  const s = now.getSeconds();
  const ms = now.getMilliseconds();

  const secFrac = s + ms / 1000;
  const minFrac = m + secFrac / 60;
  const hourFrac = h + minFrac / 60;

  const hourDeg = hourFrac * 30;
  const minDeg = minFrac * 6;
  const secDeg = secFrac * 6;

  const R = 20;
  const C = 2 * Math.PI * R;
  const dashOffset = C * (1 - secFrac / 60);

  const isDay = now.getHours() >= 6 && now.getHours() < 18;
  const HAND_EASE = "transform 0.9s cubic-bezier(0.22, 1, 0.36, 1)";

  return (
    <svg viewBox="0 0 44 44" width={40} height={40} aria-hidden className="shrink-0 text-neu-faint">
      {/* Dial track — the neutral ring the accent sweep runs over. */}
      <circle cx="22" cy="22" r={R} fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="2" />

      {/* Seconds sweep — the dial's one accent. */}
      <circle
        cx="22" cy="22" r={R}
        fill="none"
        stroke="var(--neu-accent-line)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 22 22)"
        className="transition-[stroke-dashoffset] duration-100 ease-linear"
      />

      {/* Major ticks (every hour) */}
      {Array.from({ length: 12 }, (_, i) => (
        <line
          key={`maj-${i}`}
          x1="22" y1="4.5" x2="22" y2="7.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.85"
          transform={`rotate(${i * 30} 22 22)`}
        />
      ))}
      {/* Minor ticks (every 5 minutes, offset between majors) */}
      {Array.from({ length: 12 }, (_, i) => (
        <line
          key={`min-${i}`}
          x1="22" y1="5" x2="22" y2="6.5"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.35"
          transform={`rotate(${i * 30 + 15} 22 22)`}
        />
      ))}

      {/* Hour hand (counterweighted) */}
      <line
        x1="22" y1="26" x2="22" y2="13.5"
        stroke="var(--neu-text-primary)"
        strokeWidth="2.6"
        strokeLinecap="round"
        transform={`rotate(${hourDeg} 22 22)`}
        style={{ transition: HAND_EASE }}
      />
      {/* Minute hand (counterweighted) */}
      <line
        x1="22" y1="27" x2="22" y2="9.5"
        stroke="var(--neu-text-primary)"
        strokeWidth="1.8"
        strokeLinecap="round"
        transform={`rotate(${minDeg} 22 22)`}
        style={{ transition: HAND_EASE }}
      />
      {/* Second hand — ink red, the same red the system uses for a typed
          negative value, so it clears AA on both surfaces. */}
      <g transform={`rotate(${secDeg} 22 22)`}>
        <line x1="22" y1="28.5" x2="22" y2="7" stroke="var(--neu-ink-red)" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="22" cy="8" r="1.3" fill="var(--neu-ink-red)" />
      </g>

      {/* Centre hub — ink with an accent core that pulses. */}
      <circle cx="22" cy="22" r="3.2" fill="var(--neu-text-primary)" />
      <circle cx="22" cy="22" r="1.2" fill="var(--neu-accent-line)" className="animate-glow-pulse" />

      {/* Day / night badge */}
      <g
        transform="translate(33.5 3) scale(0.29)"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={cn("pointer-events-none", isDay ? "text-neu-ink-amber" : "text-neu-ink-cyan")}
      >
        <DayNightIcon isDay={isDay} />
      </g>
    </svg>
  );
}

/* ─── Digital readout ─── */

/* The readout is the visual rendering of the value the widget already states
   as a single `aria-label`, so it is hidden from assistive tech: otherwise a
   screen reader reads "09 : 41 : 07 PM, Wed, Sep 25" *after* the label that
   says the same thing in one sentence. */
function ReadoutWindow({ children }: { children: React.ReactNode }) {
  return (
    /* Hidden below `xl`: on the widths where the bar is tightest the dial is
       what identifies the instrument, and the readout is the widest thing in
       it. The widget's `aria-label` states the full time at every width, so
       nothing is lost to assistive tech when the digits are not rendered. */
    <div aria-hidden className="neu-inset-sm hidden min-w-0 flex-col gap-[3px] rounded-[var(--neu-radius-sm)] px-2.5 py-1 xl:flex" dir="ltr">
      {children}
    </div>
  );
}

function DigitalReadout({ localeStr }: { localeStr: string }) {
  const { t } = useI18n();
  const now = useNow(1000);

  // Hydration-safe skeleton until the first client tick.
  if (!now) {
    return (
      <ReadoutWindow>
        <span className="h-[15px] w-[104px] animate-pulse rounded bg-neu-sunken" />
        <span className="h-[9px] w-[78px] animate-pulse rounded bg-neu-sunken" />
      </ReadoutWindow>
    );
  }

  const h12 = now.getHours() % 12 === 0 ? 12 : now.getHours() % 12;
  const ampm = now.getHours() < 12 ? t("clock.am") : t("clock.pm");
  const colonOn = now.getSeconds() % 2 === 1;

  const date = now.toLocaleDateString(localeStr, { weekday: "short", day: "numeric", month: "short" });
  // `<time>` rather than a bare span: the readout is a date-time value, and the
  // machine-readable form is the one thing a plain span cannot carry.
  const iso = now.toISOString();
  const dayElapsedPct = ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400) * 100;

  return (
    <ReadoutWindow>
      {/* Time row */}
      <div className="flex items-baseline gap-[3px] leading-none">
        <TimeDigit value={h12} localeStr={localeStr} className="text-[15px]" />
        <BlinkColon on={colonOn} className="text-[13px]" />
        <TimeDigit value={now.getMinutes()} localeStr={localeStr} className="text-[15px]" />
        <BlinkColon on={colonOn} className="text-[13px]" />
        <TimeDigit value={now.getSeconds()} localeStr={localeStr} className="text-[15px]" />
        <span className={cn("ms-0.5 rounded px-1 py-px text-[8px] font-bold uppercase tracking-wider", CHIP_TEXT)}>
          {ampm}
        </span>
      </div>

      {/* Date + day-elapsed bar */}
      <div className="flex items-center gap-1.5">
        <time dateTime={iso} className="truncate text-[10px] font-medium text-neu-faint">{date}</time>
        <span
          className="hidden h-[3px] w-10 flex-1 overflow-hidden rounded-full bg-neu-sunken min-[480px]:block"
          title={t("clock.dayProgress")}
        >
          <span
            className="block h-full rounded-full bg-neu-accent-solid"
            style={{ width: `${dayElapsedPct}%` }}
          />
        </span>
      </div>
    </ReadoutWindow>
  );
}

/* ─── Compact readout ───
   The dial is the instrument and the full readout is the record — but neither
   belongs on the widths where the bar is fighting for room, and a dial alone
   tells you nothing without reading the hands. So below `xl` the widget keeps
   the actual information (hours, minutes, AM/PM) and drops the flourish. */

function CompactReadout({ localeStr }: { localeStr: string }) {
  const { t } = useI18n();
  const now = useNow(1000);

  if (!now) {
    return <span aria-hidden className="neu-inset-sm h-7 w-[74px] animate-pulse rounded-[var(--neu-radius-sm)] xl:hidden" />;
  }

  const h12 = now.getHours() % 12 === 0 ? 12 : now.getHours() % 12;
  const ampm = now.getHours() < 12 ? t("clock.am") : t("clock.pm");

  /* LTR island: a clock is not text. The digits, the colon and the meridiem
     read the same way in Urdu, and the sweep is a physical direction — so the
     instrument opts out of the document's direction and states its value to
     assistive tech through a single `aria-label` in the page's language. */
  return (
    <div
      aria-hidden
      dir="ltr"
      className="neu-inset-sm flex items-center gap-0.5 rounded-[var(--neu-radius-sm)] px-1.5 py-1 xl:hidden"
    >
      <TimeDigit value={h12} localeStr={localeStr} className="text-[13px]" />
      <BlinkColon on={now.getSeconds() % 2 === 1} className="text-[11px]" />
      <TimeDigit value={now.getMinutes()} localeStr={localeStr} className="text-[13px]" />
      <span className={cn("ms-0.5 rounded px-1 py-px text-[8px] font-bold uppercase tracking-wider", CHIP_TEXT)}>
        {ampm}
      </span>
    </div>
  );
}

/* ─── Exported widget ─── */

export function LiveClock() {
  const { locale } = useI18n();
  const now = useSmoothNow();
  const localeStr = locale === "ur" ? "ur-PK" : "en-US";

  return (
    <div className="relative hidden shrink-0 sm:block" title={now ? now.toLocaleString(localeStr) : ""}>
      {/* Accent halo — the one glow the header carries, in the system cyan. */}
      <span aria-hidden className="absolute -inset-1 rounded-[var(--neu-radius-md)] bg-neu-accent-line/20 blur-md" />


      {/* Raised bezel holding the recessed dial + readout. The digits are
          real text (so they are read), and the widget names itself once for
          assistive tech instead of announcing a fragmented 09 : 41 : 07. */}
      <div
        role="group"
        aria-label={now ? now.toLocaleString(localeStr) : undefined}
        className="neu-raised relative flex items-center gap-2.5 rounded-[var(--neu-radius-md)] px-2 py-1.5 lg:px-3"
      >
        {now ? (
          <span className="hidden xl:block">
            <AnalogFace now={now} />
          </span>
        ) : (
          <span aria-hidden className="neu-inset hidden h-10 w-10 shrink-0 animate-pulse rounded-full xl:block" />
        )}
        <CompactReadout localeStr={localeStr} />
        <DigitalReadout localeStr={localeStr} />
      </div>
    </div>
  );
}
