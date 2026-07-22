/**
 * Stores the user-account listener's Telegram login (api creds + StringSession)
 * in KV so the listener auto-resumes after any restart with zero env config -
 * the user logs in once and it persists forever.
 *
 * Admin-authed (x-admin-password), same as the other management endpoints.
 * The session string is sensitive (full account access); it lives only in the
 * user's own KV store.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getListenerSession, setListenerSession } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const stored = await getListenerSession();
  return NextResponse.json(stored ?? { session: "" });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  let body: { apiId?: number; apiHash?: string; session?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.session || !body.apiId || !body.apiHash) {
    return NextResponse.json({ error: "missing apiId/apiHash/session" }, { status: 400 });
  }
  await setListenerSession({
    apiId: Number(body.apiId),
    apiHash: String(body.apiHash),
    session: String(body.session),
  });
  return NextResponse.json({ ok: true });
}
