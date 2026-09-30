import type { Metadata, Viewport } from "next";
import "./globals.css";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/constants";
import { SessionProvider } from "@/components/providers/session-provider";
import { I18nProvider } from "@/components/providers/i18n-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";

/* ═══════════════════════════════════════════════════════════════
   ROOT LAYOUT
   Top-level layout for the entire application.
   All pages inherit these fonts, metadata, and providers.
   ═══════════════════════════════════════════════════════════════ */

/* ─── UI font contract (Typography System Correction) ───
   Every family the UI names ships as a local woff2 under /fonts and is
   declared with plain @font-face at the top of globals.css — one
   mechanism for the screen, the print windows and the receipt
   rasterizer, all self-hosted from the app origin (no runtime network;
   verified offline). Plain @font-face is used instead of next/font
   because next/font registers faces under hashed names, so the literal
   design-system names in globals.css ("IBM Plex Sans", "JetBrains
   Mono") would never resolve. */

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s | ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  authors: [{ name: APP_NAME }],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximumScale: blocking pinch-zoom fails WCAG 1.4.4 (Resize Text)
  // and frustrates low-vision users on the dashboard and receipt screens.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

function ThemeInit() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `
          (function() {
            try {
              var theme = localStorage.getItem('elite-pos-theme');
              if (theme === 'golden') {
                // Golden Elite is its own surface. Adding it here (before
                // paint) prevents a flash of Neu light on a cold load.
                document.documentElement.classList.add('golden');
                document.documentElement.setAttribute('data-theme', 'golden');
              } else if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                document.documentElement.classList.add('dark');
                document.documentElement.setAttribute('data-theme', 'dark');
              } else {
                document.documentElement.classList.add('light');
                document.documentElement.setAttribute('data-theme', 'light');
              }
              var locale = localStorage.getItem('elite-pos-locale');
              if (locale === 'ur') {
                document.documentElement.dir = 'rtl';
                document.documentElement.lang = 'ur';
              }
            } catch(e) {}
          })();
        `,
      }}
    />
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
    >
      <body className="antialiased">
        <ThemeInit />
        <SessionProvider>
          <ThemeProvider>
            <I18nProvider>{children}</I18nProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
