/* ═══════════════════════════════════════════════════════════════
   API ERROR PARSING — regression guard
   The API answers a rejected write either with a plain message or with
   Zod's field map. `parseApiError` is the one place that knows both, so
   forms can underline the exact input. These tests pin the contract.

   Run: npx tsx --test tests/api-error.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApiError, readApiError } from "@/lib/api-error";

test("a plain string error becomes the message with no field target", () => {
  const parsed = parseApiError({ error: "Email already in use" }, "fallback");
  assert.equal(parsed.message, "Email already in use");
  assert.deepEqual(parsed.fields, {});
  assert.deepEqual(parsed.raw, {});
});

test("Zod's field map maps each field to its first message", () => {
  const parsed = parseApiError(
    { error: { name: ["Name is required"], email: ["Email is invalid"] } },
    "fallback"
  );
  assert.deepEqual(parsed.fields, {
    name: "Name is required",
    email: "Email is invalid",
  });
  assert.equal(parsed.message, "Name is required, Email is invalid");
});

test("multiple messages on one field are all kept in `raw`, first in `fields`", () => {
  const parsed = parseApiError({ error: { password: ["Too short", "Needs a digit"] } }, "fallback");
  assert.deepEqual(parsed.raw["password"], ["Too short", "Needs a digit"]);
  assert.equal(parsed.fields["password"], "Too short");
});

test("a hand-written field map of plain strings is accepted", () => {
  const parsed = parseApiError({ error: { sku: "A product with this SKU already exists" } }, "fallback");
  assert.equal(parsed.fields["sku"], "A product with this SKU already exists");
});

test("blank messages are dropped rather than rendered as empty red text", () => {
  const parsed = parseApiError({ error: { name: ["  "] } }, "fallback");
  assert.deepEqual(parsed.fields, {});
  assert.equal(parsed.message, "fallback");
});

test("a payload with no usable error falls back", () => {
  assert.equal(parseApiError({}, "fallback").message, "fallback");
  assert.equal(parseApiError({ error: {} }, "fallback").message, "fallback");
  assert.equal(parseApiError(null, "fallback").message, "fallback");
  assert.equal(parseApiError({ ok: false }, "fallback").message, "fallback");
});

test("an empty string error does not shadow the fallback", () => {
  assert.equal(parseApiError({ error: "" }, "fallback").message, "fallback");
});

test("readApiError tolerates a non-JSON body (proxy HTML page)", async () => {
  const res = new Response("<html>500</html>", { status: 500 });
  const parsed = await readApiError(res, "fallback");
  assert.equal(parsed.message, "fallback");
  assert.deepEqual(parsed.fields, {});
});

test("readApiError reads a field-keyed JSON body", async () => {
  const res = new Response(JSON.stringify({ error: { email: ["Email already in use"] } }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });
  const parsed = await readApiError(res, "fallback");
  assert.equal(parsed.fields["email"], "Email already in use");
});
