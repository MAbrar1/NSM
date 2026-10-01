import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Enforce consistent code quality
      "no-console": "warn",
      "no-unused-vars": "off", // Let TypeScript handle this
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",

      // React best practices
      "react/self-closing-comp": "warn",
      "react/jsx-curly-brace-presence": ["warn", { props: "never" }],

      // Import ordering (basic)
      "no-duplicate-imports": "warn",

      // Dialogs must be explicit: DialogBody is the only scrollable region
      // and DialogFooter stays pinned. The legacy auto-wrap shim has been
      // removed, so plain padding-div bodies no longer scroll correctly.
      "@local/require-dialog-body": "warn",
      "@local/no-dialog-footer-div": "warn",

      // Cents formatting has exactly one home: centsToMajorString() in
      // @/lib/money/money. Re-deriving (x / 100).toFixed(2) at call sites
      // is how the 68-copy duplication crept in.
      "@local/no-raw-cents-format": "error",

      // Cents SCALING has exactly one home too: majorToCents() /
      // centsToMajor() in @/lib/money/money. A raw `x / 100` or `100 * x`
      // on a money value skips the guards (non-finite → 0, integer
      // results, Prisma-Int saturation) and is how silent money
      // regressions ship. Percent idioms — (a / b) * 100, taxRate / 100 —
      // stay legal; only the cent-scale shapes are banned.
      "@local/no-raw-money-scale": "error",

      // `truncate` HIDES text with no recovery unless the element also
      // exposes the full string via title/aria-label (browser tooltip,
      // screen-reader announcement). Bilingual labels make this worse:
      // an Urdu name plus an English SKU is the first thing to clip.
      "@local/require-truncate-title": "error",

      // Slug generation has exactly one home: slugify() in @/lib/utils.
      // Re-typing the lowercase/dash regex chain at create/update routes
      // is how 11 divergent copies appeared.
      "@local/no-raw-slugify": "error",

      // Locale-less toLocaleString/toLocaleDateString/toLocaleTimeString
      // silently follow each browser's locale. Pages that deliberately
      // switch locales (dashboard, live-clock) pass one explicitly.
      "@local/no-raw-datetime": "error",
    },
  },
  {
    // next-env.d.ts is machine-written by `next dev`/`next build` (its own
    // header says "should not be edited"); the routes reference it emits is
    // a triple-slash by Next's design, so the rule can never pass there.
    files: ["next-env.d.ts"],
    rules: {
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
  {
    ignores: ["node_modules/", ".next/", ".next-prod/", "dist/", "prisma/"],
  },
];

/* Local plugin: dialog structure lint rules (see rules object above). */
const dialogRulesPlugin = {
  rules: {
    "require-dialog-body": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "DialogContent should use DialogBody for its middle content — it is the only scrollable region of a dialog.",
        },
        schema: [],
      },
      create(context) {
        // A dialog may legitimately nest its body — inside a <form> that owns
        // the submit, or behind a `{open && …}` conditional. The contract is
        // "a DialogBody exists as the scroll region", not "it is a direct
        // child", so scan the whole subtree rather than only the top level.
        const containsDialogBody = (n) => {
          if (!n || typeof n !== "object") return false;
          if (
            n.type === "JSXElement" &&
            n.openingElement &&
            n.openingElement.name &&
            n.openingElement.name.type === "JSXIdentifier" &&
            n.openingElement.name.name === "DialogBody"
          ) {
            return true;
          }
          for (const key of Object.keys(n)) {
            if (key === "parent" || key === "loc" || key === "range") continue;
            const value = n[key];
            if (Array.isArray(value)) {
              if (value.some(containsDialogBody)) return true;
            } else if (value && typeof value === "object") {
              if (containsDialogBody(value)) return true;
            }
          }
          return false;
        };
        return {
          JSXElement(node) {
            const name = node.openingElement.name;
            if (name.type !== "JSXIdentifier" || name.name !== "DialogContent") return;
            const hasBody = containsDialogBody(node);
            if (!hasBody) {
              context.report({
                node,
                message:
                  "DialogContent without DialogBody: wrap middle content in DialogBody so the dialog scrolls predictably.",
              });
            }
          },
        };
      },
    },
    "no-dialog-footer-div": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Use the DialogFooter component instead of hand-rolled footer divs (they must stay shrink-0/pinned).",
        },
        schema: [],
      },
      create(context) {
        function isInsideDialogContent(node) {
          let p = node.parent;
          while (p) {
            if (
              p.type === "JSXElement" &&
              p.openingElement.name.type === "JSXIdentifier" &&
              p.openingElement.name.name === "DialogContent"
            )
              return true;
            p = p.parent;
          }
          return false;
        }
        return {
          JSXElement(node) {
            const name = node.openingElement.name;
            if (name.type !== "JSXIdentifier" || name.name !== "div") return;
            const cls = node.openingElement.attributes.find(
              (a) => a.type === "JSXAttribute" && a.name.name === "className"
            );
            const val =
              cls && cls.value && cls.value.type === "Literal" ? cls.value.value || "" : "";
            if (/border-t/.test(val) && /justify-end|justify-between/.test(val) && isInsideDialogContent(node)) {
              context.report({
                node,
                message:
                  "Hand-rolled footer div inside DialogContent — use DialogFooter (shrink-0, border, pinned).",
              });
            }
          },
        };
      },
    },
    "no-raw-cents-format": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Use centsToMajorString() from @/lib/money/money instead of re-deriving (cents / 100).toFixed(2).",
        },
        schema: [],
      },
      create(context) {
        // The one legal home for the raw conversion is lib/money itself.
        const file = context.getFilename().replace(/\\/g, "/");
        if (file.includes("/src/lib/money/")) return {};
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression") return;
            if (callee.property.type !== "Identifier" || callee.property.name !== "toFixed") return;
            const arg = node.arguments[0];
            if (!arg || arg.type !== "Literal" || arg.value !== 2) return;
            const obj = callee.object;
            if (obj.type !== "BinaryExpression" || obj.operator !== "/") return;
            if (obj.right.type !== "Literal" || obj.right.value !== 100) return;
            context.report({
              node,
              message:
                "Raw (cents / 100).toFixed(2) — use centsToMajorString() from @/lib/money/money so cents formatting has one home.",
            });
          },
        };
      },
    },
    "no-raw-money-scale": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Cents scaling belongs to majorToCents()/centsToMajor() in @/lib/money/money — a raw `/ 100` or `100 *` skips the money guards (non-finite → 0, integer results, Int saturation). Percent math like (a / b) * 100 is not affected.",
        },
        schema: [],
      },
      create(context) {
        // lib/money is the one legal home for the raw conversions.
        const file = context.getFilename().replace(/\\/g, "/");
        if (file.includes("/src/lib/money/")) return {};
        const isHundred = (n) => n && n.type === "Literal" && n.value === 100;
        return {
          BinaryExpression(node) {
            // money / 100 — the cents→major direction. (`x * 100` is NOT
            // reported: (a / b) * 100 is the percent idiom used across
            // the dashboard, and banning it would bury the signal.)
            if (node.operator === "/" && isHundred(node.right)) {
              context.report({
                node,
                message:
                  "Raw ÷ 100 on a money value — use centsToMajor()/centsToMajorString() from @/lib/money/money so cents scaling keeps its guards. Percent math is exempt; if this is percent math, restructure so the reviewer can see it.",
              });
              return;
            }
            // 100 * x — the major→cents direction written raw.
            if (node.operator === "*" && isHundred(node.left)) {
              context.report({
                node,
                message:
                  "Raw 100 × on a money value — use majorToCents() from @/lib/money/money so cents scaling keeps its guards.",
              });
            }
          },
        };
      },
    },
    "require-truncate-title": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Any element using the `truncate` utility must also carry `title` (or `aria-label`) so the clipped text stays reachable — hover tooltip + assistive-tech announcement.",
        },
        schema: [],
      },
      create(context) {
        const ts_isJsxElement = (n) => n.type === "JSXElement";
        const ts_isJsxAttribute = (n) => n.type === "JSXAttribute";
        function check(node) {
          const attrs = ts_isJsxElement(node)
            ? node.openingElement.attributes
            : node.attributes;
          if (!attrs || !Array.isArray(attrs.properties)) return;
          let hasTruncate = false;
          let hasEscape = false;
          for (const attr of attrs.properties) {
            if (!ts_isJsxAttribute(attr)) continue;
            const name = attr.name?.name;
            if (name === "title" || name === "aria-label") hasEscape = true;
            if (
              name === "className" &&
              attr.initializer &&
              attr.initializer.getText().includes("truncate")
            ) {
              hasTruncate = true;
            }
          }
          if (hasTruncate && !hasEscape) {
            context.report({
              node,
              message:
                "`truncate` without `title`/`aria-label` — clipped text is unreachable. Add title={the same value} (see scripts/codemod-truncate-title.mjs).",
            });
          }
        }
        return { JSXElement: check, JSXSelfClosingElement: check };
      },
    },
    "no-raw-slugify": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Use slugify() from @/lib/utils instead of re-typing the lowercase/dash regex chain.",
        },
        schema: [],
      },
      create(context) {
        // The one legal home for the raw chain is lib/utils itself.
        const file = context.getFilename().replace(/\\/g, "/");
        if (file.includes("/src/lib/utils.ts")) return {};
        return {
          Literal(node) {
            if (node.regex === undefined) return;
            if (node.regex.pattern !== "[^a-z0-9]+") return;
            context.report({
              node,
              message:
                "Raw slug regex — use slugify() from @/lib/utils so slug generation has one home.",
            });
          },
        };
      },
    },
    "no-raw-datetime": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Locale-less toLocaleString/toLocaleDateString/toLocaleTimeString drifts per browser — use formatDate/formatTime/formatDateTime from @/lib/utils or pin a locale.",
        },
        schema: [],
      },
      create(context) {
        // The live clock intentionally manages its own locale machinery.
        const file = context.getFilename().replace(/\\/g, "/");
        if (file.includes("/src/components/layout/live-clock.tsx")) return {};
        return {
          CallExpression(node) {
            if (node.arguments.length > 0) return; // an explicit locale is deliberate
            const callee = node.callee;
            if (callee.type !== "MemberExpression") return;
            if (callee.property.type !== "Identifier") return;
            const name = callee.property.name;
            if (
              name !== "toLocaleString" &&
              name !== "toLocaleDateString" &&
              name !== "toLocaleTimeString"
            )
              return;
            context.report({
              node,
              message:
                "Locale-less toLocale*() — use formatDate()/formatTime()/formatDateTime() from @/lib/utils (or pin an explicit locale) so display output doesn't drift per browser.",
            });
          },
        };
      },
    },
  },
};
eslintConfig.splice(eslintConfig.length - 1, 0, { plugins: { "@local": dialogRulesPlugin } });

export default eslintConfig;
