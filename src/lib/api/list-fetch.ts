/* ═══════════════════════════════════════════════════════════════
   LIST FETCH — one JSON loader for every server-paged list page.

   The loaders used to do `const data = await res.json(); setRows(
   data.rows ?? [])` with no `res.ok` check. A 500 response's JSON
   error body parsed fine, `?? []` swallowed it, and the table showed
   the "no X yet" empty state — indistinguishable from real empty
   data (the suppliers API's nulls:"last" 500 shipped exactly this
   way). These helpers fail loudly instead: a non-2xx answer throws,
   so the page's existing `catch → setLoadError(true)` renders the
   retry-able error state.
   ═══════════════════════════════════════════════════════════════ */

/** Fetch a list endpoint and decode its JSON. Any non-2xx status
 *  throws (the error body is surfaced in the message when parseable),
 *  so callers' `catch` blocks — a load-error state, a toast — fire
 *  for server failures, not just network drops. */
export async function fetchListPayload<T = Record<string, unknown>>(
  url: string
): Promise<T> {
  const res = await fetch(url);
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON body — the status check below reports it */
  }
  if (!res.ok) {
    const detail =
      (payload as { error?: unknown } | null | undefined)?.error;
    const message =
      typeof detail === "string" && detail.trim()
        ? detail
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return (payload ?? {}) as T;
}
