/* ═══════════════════════════════════════════════════════════════
   API ERROR PARSING — one shape for every failed request.

   The API answers a rejected write in one of two shapes:

     { error: "Email already in use" }              // a message
     { error: { email: ["Email already in use"] } } // field -> messages

   The second is Zod's `error.flatten().fieldErrors`, plus hand-written
   twins for uniqueness checks. Which one you get depended on the route,
   so callers either stringified the field map into one unhelpful toast
   ("name, email" — with no indication WHICH field) or, worse, ignored
   the failure entirely.

   This normalises both into a `fields` map the form can hand straight
   to `<Input error={...}>`, alongside a single `message` for a summary
   toast. Field names match the API payload keys, which match the form
   field names, so `fields.email` is what the email input reads.
   ═══════════════════════════════════════════════════════════════ */

/** `field -> [messages]`, the shape `zodError.flatten().fieldErrors` emits. */
export type FieldErrorMap = Record<string, string[]>;

export interface ParsedApiError {
  /** One line for a toast or a form-level banner. Never empty. */
  message: string;
  /** `field -> first message`, ready for `<Input error>`. Empty when the
   *  route returned a plain string (nothing is field-addressable). */
  fields: Record<string, string>;
  /** The full `field -> [messages]` map, for callers that want all of them. */
  raw: FieldErrorMap;
}

/** A field-error map: every value is a string or an array of strings. */
function isFieldErrorMap(value: unknown): value is FieldErrorMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const values = Object.values(value);
  if (values.length === 0) return false;
  return values.every(
    (v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))
  );
}

/** Parse a decoded JSON error payload. `fallback` is used when the payload
 *  carries nothing usable (e.g. an HTML 500 page or an empty body). */
export function parseApiError(payload: unknown, fallback: string): ParsedApiError {
  const error = (payload as { error?: unknown } | null | undefined)?.error;

  if (typeof error === "string" && error.trim()) {
    return { message: error, fields: {}, raw: {} };
  }

  if (isFieldErrorMap(error)) {
    const raw: FieldErrorMap = {};
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(error)) {
      const list = (Array.isArray(value) ? value : [value]).filter((m) => m.trim() !== "");
      raw[key] = list;
      if (list[0]) fields[key] = list[0];
    }
    const message = Object.values(raw).flat().join(", ");
    return { message: message || fallback, fields, raw };
  }

  return { message: fallback, fields: {}, raw: {} };
}

/** Read a failed `Response` into a normalised error. Never throws — a body
 *  that is not JSON (a proxy's HTML error page, a truncated stream) falls
 *  back to `fallback` rather than surfacing a parse error. */
export async function readApiError(res: Response, fallback: string): Promise<ParsedApiError> {
  try {
    return parseApiError(await res.json(), fallback);
  } catch {
    return { message: fallback, fields: {}, raw: {} };
  }
}
