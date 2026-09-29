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
  },
};
eslintConfig.splice(eslintConfig.length - 1, 0, { plugins: { "@local": dialogRulesPlugin } });

export default eslintConfig;
