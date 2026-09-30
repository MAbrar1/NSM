import { NextRequest, NextResponse } from "next/server";

/* ═══════════════════════════════════════════════════════════════
   API HANDLER WRAPPER
   Wraps a route handler so unexpected throws become a uniform JSON
   500 with a request id (logged for correlation) instead of whatever
   a framework default leaks. Handlers that do their own try/catch
   keep working unchanged — this is a safety net + a standard for new
   endpoints.

   Usage:
     export const GET = withApiHandler("PRODUCTS_GET", async (req) => {
       ...
       return NextResponse.json({ items });
     });
   ═══════════════════════════════════════════════════════════════ */

export function withApiHandler(
  tag: string,
  handler: (request: NextRequest, requestId: string) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Honor an upstream request id (proxy/load balancer) or mint one.
    const requestId =
      request.headers.get("x-request-id") ??
      `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    try {
      const res = await handler(request, requestId);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (error) {
      console.error(`[${tag}] ${requestId}`, error);
      return NextResponse.json(
        {
          error: "Internal server error",
          requestId, // safe to show users; lets support find the log line
        },
        { status: 500, headers: { "x-request-id": requestId } }
      );
    }
  };
}
