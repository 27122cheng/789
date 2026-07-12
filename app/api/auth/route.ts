/**
 * Auth status + optional custom password.
 *   GET  -> { mode: "env" | "kv" | "default", durableStore }
 *           mode "default" means the built-in default password is active
 *           and the UI logs in automatically.
 *   POST { password } -> replaces the default with a custom password
 *           (stored hashed in KV). Optional - the app works without it.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthMode, hashPassword, requireAdmin } from "@/lib/auth";
import { hasDurableStore, setAdminPasswordHash } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    mode: await adminAuthMode(),
    durableStore: hasDurableStore(),
  });
}

export async function POST(req: NextRequest) {
  // must already be logged in (default password counts) to change it
  const denied = await requireAdmin(req);
  if (denied) return denied;

  if (!hasDurableStore()) {
    return NextResponse.json(
      { error: "尚未連接資料庫，自訂密碼無法保存（預設密碼仍可使用）" },
      { status: 503 }
    );
  }
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const pw = (body.password ?? "").trim();
  if (pw.length < 8) {
    return NextResponse.json({ error: "密碼至少需要 8 個字元" }, { status: 400 });
  }
  await setAdminPasswordHash(hashPassword(pw));
  return NextResponse.json({ ok: true });
}
