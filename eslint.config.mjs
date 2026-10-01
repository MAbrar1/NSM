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
    ignores: ["node_modules/", ".next/", "dist/", "prisma/"],
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
