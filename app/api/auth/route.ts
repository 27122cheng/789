/**
 * First-run admin password flow.
 *   GET  -> { mode: "env" | "kv" | "unconfigured", durableStore }
 *   POST { password } -> creates the admin password (only when unconfigured)
 *
 * Once a password exists (env var or KV), POST refuses - the password can
 * then only be changed by clearing the KV key or setting ADMIN_PASSWORD.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthMode, hashPassword } from "@/lib/auth";
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
  const mode = await adminAuthMode();
  if (mode !== "unconfigured") {
    return NextResponse.json(
      { error: "管理密碼已存在，不能重複建立" },
      { status: 409 }
    );
  }
  if (!hasDurableStore()) {
    return NextResponse.json(
      {
        error:
          "尚未連接資料庫，密碼無法保存。請先到 Vercel 專案 → Storage → " +
          "Create Database → 選 Upstash Redis，建立後 Redeploy 再回來。",
      },
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
    return NextResponse.json(
      { error: "密碼至少需要 8 個字元" },
      { status: 400 }
    );
  }
  await setAdminPasswordHash(hashPassword(pw));
  return NextResponse.json({ ok: true });
}
