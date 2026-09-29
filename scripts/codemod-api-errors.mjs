/* ═══════════════════════════════════════════════════════════════
   CODEMOD — API error envelopes → src/lib/api-errors.ts

   One-shot migration that replaces the two hand-written field/validation
   envelopes in `src/app/api` with the shared helpers:

     NextResponse.json(
       { error: result.error.flatten().fieldErrors },
       { status: 400 }
     )                              →  validationError(result.error)

     NextResponse.json(
       { error: { email: ["already in use"] } },
       { status: 409 }
     )                              →  fieldError({ email: ["already in use"] }, 409)

   It also routes plain-string envelopes with a literal status through
   `apiError()`, so the envelope itself lives in exactly one module:

     NextResponse.json({ error: "Failed to fetch" }, { status: 500 })
       →  apiError("Failed to fetch", 500)

   Variable messages, template literals and dynamic statuses are left for a
   human — this only rewrites the unambiguous literals.

   Safe to re-run: it is a no-op once no matching envelopes remain.
   Usage: node scripts/codemod-api-errors.mjs
   ═══════════════════════════════════════════════════════════════ */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "src/app/api");

const FLATTEN =
  /NextResponse\.json\(\s*\{\s*error:\s*(result|parsed)\.error\.flatten\(\)\.fieldErrors\s*\},\s*\{\s*status:\s*400\s*\}\s*\)/g;

// Inner object has no nested braces (all are `{ field: ["msg"] }`), so this
// captures the whole map without needing a real parser.
const FIELD_MAP =
  /NextResponse\.json\(\s*\{\s*error:\s*(\{[^{}]*\})\s*\},\s*\{\s*status:\s*(\d+)\s*\}\s*\)/g;

// Literal message + literal status, one-line or wrapped. `[^"]*` keeps this
// off template literals and concatenations.
const PLAIN =
  /NextResponse\.json\(\s*\{\s*error:\s*"([^"]*)"\s*\},\s*\{\s*status:\s*(\d+)\s*\}\s*\)/g;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

let changed = 0;

for (const file of walk(API_DIR)) {
  let text = fs.readFileSync(file, "utf8");
  const before = text;

  text = text.replace(FLATTEN, "validationError($1.error)");
  text = text.replace(FIELD_MAP, (_m, fields, status) => `fieldError(${fields}, ${status})`);
  text = text.replace(PLAIN, (_m, message, status) => `apiError("${message}", ${status})`);

  const used = new Set();
  if (/\bvalidationError\(/.test(text)) used.add("validationError");
  if (/\bfieldError\(/.test(text)) used.add("fieldError");
  if (/\bapiError\(/.test(text)) used.add("apiError");

  // Union the helpers this file now uses into a single import. A file
  // migrated in an earlier pass already has the import line, so merging is
  // required — checking `includes` alone would silently drop `apiError`.
  const IMPORT_RE = /import \{([^}]*)\} from "@\/lib\/api-errors";/;
  if (used.size > 0) {
    const existingMatch = text.match(IMPORT_RE);
    if (existingMatch) {
      const existing = existingMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
      const merged = [...new Set([...existing, ...used])].sort().join(", ");
      text = text.replace(IMPORT_RE, `import { ${merged} } from "@/lib/api-errors";`);
    } else {
      const importLine = `import { ${[...used].sort().join(", ")} } from "@/lib/api-errors";\n`;
      const nextServer = /^import .*from "next\/server";\r?\n/m;
      if (nextServer.test(text)) {
        text = text.replace(nextServer, (m) => m + importLine);
      } else {
        text = importLine + text;
      }
    }
  }

  if (text === before) continue;

  fs.writeFileSync(file, text);
  changed++;
  console.log("updated", path.relative(ROOT, file));
}

console.log(`\n${changed} file(s) updated.`);
