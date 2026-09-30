/* ═══════════════════════════════════════════════════════════════
   SERVER API ERRORS — contract + ratchet
   `src/lib/api-errors.ts` is the producer; `src/lib/api-error.ts` is the
   consumer. These tests pin that the producer emits exactly the two
   shapes the consumer knows, and that no route has drifted back to
   hand-writing an envelope.

   Run: npx tsx --test tests/api-errors.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { apiError, fieldError, validationError } from "@/lib/api/api-errors";
import { parseApiError } from "@/lib/api/api-error";

const ROOT = process.cwd();

function apiFiles(dir = path.join(ROOT, "src/app/api"), acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) apiFiles(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

test("apiError emits the plain-message shape with the given status", async () => {
  const res = apiError("Nope", 403);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.deepEqual(body, { error: "Nope" });
  assert.equal(parseApiError(body, "fallback").message, "Nope");
});

test("apiError defaults to 400", () => {
  assert.equal(apiError("bad").status, 400);
});

test("fieldError emits a field-keyed map that parses field-by-field", async () => {
  const res = fieldError({ email: ["Email already in use"] }, 409);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(body, { error: { email: ["Email already in use"] } });
  const parsed = parseApiError(body, "fallback");
  assert.equal(parsed.fields["email"], "Email already in use");
});

test("validationError forwards Zod's flatten().fieldErrors verbatim", async () => {
  const schema = z.object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Email is invalid"),
  });
  const result = schema.safeParse({ name: "", email: "not-an-email" });
  assert.equal(result.success, false);
  if (result.success) return;

  const res = validationError(result.error);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: Record<string, string[]> };
  assert.equal(body.error["name"]?.[0], "Name is required");
  assert.equal(body.error["email"]?.[0], "Email is invalid");

  // …and the client parser understands it.
  const parsed = parseApiError(body, "fallback");
  assert.equal(parsed.fields["name"], "Name is required");
});

/* ── ratchet: nothing may hand-write an envelope the helpers own ── */

test("no API route flattens a Zod error outside the helper", () => {
  const offenders = apiFiles().filter((f) => /\.flatten\(\)/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [], "use validationError()");
});

test("no API route hand-writes a field-error map", () => {
  const offenders = apiFiles().filter((f) => /\{\s*error:\s*\{/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [], "use fieldError()");
});

test("no API route hand-writes a literal message + status envelope", () => {
  const pattern =
    /NextResponse\.json\(\s*\{\s*error:\s*"[^"]*"\s*\},\s*\{\s*status:\s*\d+\s*\}\s*\)/;
  const offenders = apiFiles().filter((f) => pattern.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [], "use apiError()");
});
