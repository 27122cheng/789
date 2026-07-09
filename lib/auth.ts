import { NextRequest, NextResponse } from "next/server";

/**
 * All management endpoints (settings, state, setup-webhook) require the
 * ADMIN_PASSWORD environment variable to be set on the deployment and sent
 * by the client in the x-admin-password header. Without ADMIN_PASSWORD the
 * endpoints refuse to run so API keys can never be exposed on a fresh,
 * unconfigured deployment.
 */
export function requireAdmin(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: "ADMIN_PASSWORD is not configured on the server. Set it in Vercel → Project → Settings → Environment Variables." },
      { status: 503 }
    );
  }
  const got = req.headers.get("x-admin-password") ?? "";
  if (got !== expected) {
    return NextResponse.json({ error: "invalid admin password" }, { status: 401 });
  }
  return null;
}
