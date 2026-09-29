/* ═══════════════════════════════════════════════════════════════
   API ERRORS — the server's side of the one-shape contract.

   Every rejected API request answers with exactly one of two bodies:

     { error: "Email already in use" }               // a message
     { error: { email: ["Email already in use"] } }  // field -> messages

   The client decodes both through `@/lib/api-error` (note the singular:
   that module only *parses*). This module is the *producer*, so a route
   never hand-writes the envelope and the field map can never drift from
   what `parseApiError` expects.

   - `apiError(msg, status)`     — a plain message (auth, 404, 500…).
   - `fieldError(fields, status)`— a hand-written field map (uniqueness,
                                    "not found"/"required" on a named input).
   - `validationError(zodErr)`   — Zod's `flatten().fieldErrors`, so a
                                    schema rejection is field-addressable.

   A return value is a `NextResponse`, so routes read `return apiError(...)`.
   ═══════════════════════════════════════════════════════════════ */

import { NextResponse } from "next/server";
import type { ZodError } from "zod";

/** `field -> [messages]`, what Zod's `flatten().fieldErrors` emits. */
export type ApiFieldErrors = Record<string, string[]>;

/** A single human-readable message, e.g. a 403 or a 500. */
export function apiError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** An explicit `field -> [messages]` map for checks Zod doesn't own
 *  (duplicate email, a referenced row that vanished, …). */
export function fieldError(fields: ApiFieldErrors, status = 400): NextResponse {
  return NextResponse.json({ error: fields }, { status });
}

/** A failed `safeParse` — forwards the schema's per-field messages so the
 *  form can underline the exact input. */
export function validationError(error: ZodError, status = 400): NextResponse {
  return NextResponse.json({ error: error.flatten().fieldErrors }, { status });
}
