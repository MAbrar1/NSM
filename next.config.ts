import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Isolated build directory. Defaults to `.next`; setting NEXT_DIST_DIR
     lets a production build + start run BESIDE a live dev server (which
     owns `.next` and rewrites it continuously) — e.g. for the browser
     gates while someone is using `npm run dev`. Dev/CI behaviour is
     unchanged when the variable is not set. */
  distDir: process.env["NEXT_DIST_DIR"] || ".next",

  /* Performance: Enable React Strict Mode */
  reactStrictMode: true,

  /* Don't advertise the framework in response headers */
  poweredByHeader: false,

  /* Image Optimization */
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
    formats: ["image/avif", "image/webp"],
  },

  /* Compiler Options */
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },

  /* Dev watcher exclusions.
     Browser profiles and QA artifacts must never live inside the watched tree:
     Chrome writes to a profile continuously (hundreds of files per second), so
     the dev server recompiles in an endless loop and truncates its own .next
     manifests mid-write. That surfaced as random 500s with
     "SyntaxError: Unexpected end of JSON input" on EVERY /api route — which
     made POS checkout appear broken (the browser could not load the session or
     warehouses, so the sale silently did nothing). */
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions ?? {}),
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/.next/**",
          "**/.dbg-profile*/**",
          "**/.audit-chrome-profile*/**",
          "**/.audit-shots/**",
          "**/.probe-prof*/**",
        ],
      };
    }
    return config;
  },

  /* Headers for Security */
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            // camera=self is required by the POS barcode scanner; everything
            // else that a POS has no business using is denied.
            // usb/serial are (self) so the POS can talk to configured
            // thermal printers via WebUSB/Web Serial (M3 transports);
            // everything else a POS has no business using stays denied.
            value:
              "camera=(self), microphone=(), geolocation=(), payment=(), usb=(self), serial=(self), bluetooth=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
