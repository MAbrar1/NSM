/* ═══════════════════════════════════════════════════════════════
   API HANDLER WRAPPER — contract tests
   withApiHandler replaces the hand-rolled try/catch → console.error →
   apiError(500) stanza across route files. These tests pin the
   contract: success passes through untouched, unexpected throws become
   a uniform 500 with a correlation id, the id lands in both the header
   and the body, and an upstream x-request-id is honored instead of
   minted. (The seed-guard route tests already cover the auth-first
   ordering; the wrapper deliberately sits below the auth layer.)
   Run: npx tsx --test tests/api-handler.test.ts
   ═══════════════════════════════════════════════════════════════ */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api/api-handler";

function req(url = "http://localhost/api/test", headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: "GET", headers });
}

beforeEach(() => {
  // silence the expected console.error from the failure-path tests
  const orig = console.error;
  console.error = () => {};
  return () => {
    console.error = orig;
  };
});

test("success: body and status pass through untouched", async () => {
  const GET = withApiHandler("T_GET", async () =>
    NextResponse.json({ ok: true }, { status: 201 })
  );
  const res = await GET(req());
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
});

test("unexpected throw → uniform 500 with a requestId in body and header", async () => {
  const GET = withApiHandler("T_FAIL", async () => {
    throw new Error("boom");
  });
  const res = await GET(req());
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string; requestId: string };
  assert.match(body.error, /internal server error/i);
  assert.match(body.requestId, /^req_/);
  assert.equal(res.headers.get("x-request-id"), body.requestId);
});

test("upstream x-request-id is honored, not replaced", async () => {
  const GET = withApiHandler("T_ID", async () => NextResponse.json({}));
  const res = await GET(req("http://localhost/api/test", { "x-request-id": "upstream-42" }));
  assert.equal(res.headers.get("x-request-id"), "upstream-42");
});

test("flat handlers: the request arrives as the first arg", async () => {
  let sawFirst: string | undefined;
  const GET = withApiHandler("T_FLAT", async (r) => {
    sawFirst = r?.method;
    return NextResponse.json({});
  });
  await GET(req());
  assert.equal(sawFirst, "GET");
});

test("dynamic handlers: ctx.params is awaited by the route body", async () => {
  const GET = withApiHandler<{ id: string }>("T_PARAM", async (_req, ctx) => {
    const { id } = await ctx.params;
    return NextResponse.json({ id });
  });
  const res = await GET(req(), { params: Promise.resolve({ id: "abc" }) });
  assert.deepEqual(await res.json(), { id: "abc" });
});

test("throwing AFTER building a response still returns the uniform 500", async () => {
  const GET = withApiHandler("T_PARTIAL", async () => {
    NextResponse.json({ partial: true });
    throw new Error("late failure");
  });
  const res = await GET(req());
  assert.equal(res.status, 500);
});
