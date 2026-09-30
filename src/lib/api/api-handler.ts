import { NextRequest, NextResponse } from "next/server";

/* ═══════════════════════════════════════════════════════════════
   API HANDLER WRAPPER
   Wraps a route handler so unexpected throws become a uniform JSON
   500 with a request id (logged for correlation) instead of whatever
   a framework default leaks. This replaces the hand-rolled
   try/catch → console.error → apiError(500) stanza that repeated in
   ~70 handlers — the wrapper is the same three lines, written once.

   Two overloads, because Next's generated route validators require a
   handler's second parameter to be EXACTLY the route context when it
   is declared at all (an optional `ctx?` fails ParamCheck), while a
   handler with NO second parameter is always fine:

     // flat route — one-arg export:
     export const GET = withApiHandler("BRANDS_GET", async (req) => {
       return NextResponse.json({ brands });
     });

     // dynamic segment — ctx carries the awaited params:
     export const GET = withApiHandler("BRAND_GET", async (req, ctx) => {
       const { id } = await ctx.params;
       return NextResponse.json({ ... });
     });

   Handlers that keep their own try/catch still work unchanged when
   wrapped: their catch wins, the wrapper's catch is just a net.
   ═══════════════════════════════════════════════════════════════ */

type RouteContext<P> = { params: Promise<P> };
type FlatHandler = (request: NextRequest) => Promise<NextResponse>;
type ParamHandler<P> = (
  request: NextRequest,
  ctx: RouteContext<P>
) => Promise<NextResponse>;

export function withApiHandler(tag: string, handler: FlatHandler): FlatHandler;
export function withApiHandler<P>(
  tag: string,
  handler: ParamHandler<P>
): (request: NextRequest, ctx: RouteContext<P>) => Promise<NextResponse>;
/* The implementation signature is deliberately loose (`any` ctx): both
   overload surfaces are exact, and a required-ctx handler can't be
   typed against an optional-ctx implementation without widening. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withApiHandler(tag: string, handler: (request: NextRequest, ctx: any) => Promise<NextResponse>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (request: NextRequest, ctx?: any): Promise<NextResponse> => {
    // Honor an upstream request id (proxy/load balancer) or mint one.
    const requestId =
      request.headers.get("x-request-id") ??
      `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    try {
      const res = await handler(request, ctx ?? { params: Promise.resolve({}) });
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
