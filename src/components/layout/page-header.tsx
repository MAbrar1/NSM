"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { useI18n } from "@/components/providers/i18n-provider";

/* ═══════════════════════════════════════════════════════════════
   PAGE HEADER
   Consistent spacing, breadcrumbs, responsive actions.

   The breadcrumb is a real `<ol>` inside a named `<nav>`: a trail is a list of
   steps, and assistive tech announcing "3 items" is what turns "Dashboard >
   Reports > Sales" from a run-on string into a position. The LAST crumb is the
   current page, so it carries `aria-current="page"` — the same marker the rail
   uses, which is how both surfaces agree about where you are.

   Depth is the page surface's, not the header's: this block sits flat on it
   (like the bar) and the controls it contains raise themselves. A card here
   would nest an emboss inside every page's first card.
   ═══════════════════════════════════════════════════════════════ */

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  className?: string;
}

function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: PageHeaderProps) {
  const { t } = useI18n();
  const last = breadcrumbs && breadcrumbs.length > 0 ? breadcrumbs.length - 1 : -1;

  return (
    <div className={cn("space-y-4", className)}>
      {/* Breadcrumbs */}
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label={t("nav.breadcrumb")}>
          <ol className="flex flex-wrap items-center gap-1 text-sm text-neu-faint">
            {breadcrumbs.map((crumb, index) => {
              const current = index === last;
              return (
                <li key={index} className="flex items-center gap-1">
                  {index > 0 && (
                    <svg aria-hidden className="h-3.5 w-3.5 shrink-0 text-neu-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  )}
                  {crumb.href && !current ? (
                    <a
                      href={crumb.href}
                      className="neu-focus rounded px-1 -mx-1 transition-colors hover:bg-neu-sunken hover:text-neu-primary"
                    >
                      {crumb.label}
                    </a>
                  ) : (
                    <span
                      aria-current={current ? "page" : undefined}
                      className={cn("px-1 -mx-1", current ? "font-medium text-neu-primary" : "text-neu-faint")}
                    >
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {/* Title Row */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-neu-primary sm:text-3xl">
            {title}
          </h1>
          {description && (
            <p className="text-neu-faint text-sm sm:text-base">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>

      <Separator />
    </div>
  );
}

export { PageHeader };
