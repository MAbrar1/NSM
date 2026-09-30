import { NextRequest, NextResponse } from "next/server";
import { apiError, validationError } from "@/lib/api/api-errors";
import { requirePermission } from "@/lib/api/api-auth";
import {
  processCheckout,
  CheckoutError,
  checkoutSchema,
} from "@/lib/checkout/checkout-service";

/* ═══════════════════════════════════════════════════════════════
   POS CHECKOUT API
   POST /api/pos/checkout — Process a complete POS transaction.

   Thin HTTP adapter: all business rules (server-authoritative money,
   atomic stock deduction, loyalty, payments, audit) live in
   lib/checkout-service so they are integration-testable. Errors are
   mapped to HTTP codes here.

   Route files may export ONLY HTTP handlers + route config — a
   re-export like `export { MONEY_TOLERANCE }` fails `next build`
   with "does not satisfy the constraint '{ [x: string]: never; }'".
   Import from `@/lib/checkout-math` directly instead.
   ═══════════════════════════════════════════════════════════════ */

export async function POST(request: NextRequest) {
  try {
    // Resolve the authenticated user server-side — never trust client IDs
    const { user, response } = await requirePermission("pos:create_order");
    if (response) return response;

    const body = await request.json();
    const result = checkoutSchema.safeParse(body);

    if (!result.success) {
      return validationError(result.error);
    }

    const order = await processCheckout(result.data, {
      userId: user.id,
      ipAddress:
        request.headers.get("x-forwarded-for") ??
        request.headers.get("x-real-ip") ??
        undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });

    return NextResponse.json(
      {
        order,
        message: "Transaction completed successfully",
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof CheckoutError) {
      const status = error.code === "bad_request" ? 400 : 409;
      return NextResponse.json(
        {
          code: error.code,
          error: error.message,
          ...error.extra,
        },
        { status }
      );
    }
    console.error("[POS_CHECKOUT]", error);
    return apiError("Failed to process transaction", 500);
  }
}
