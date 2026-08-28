import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getAdminPasswordHash } from "./store";

/**
 * Admin auth for management endpoints (settings, state, setup-webhook).
 *
 * Two sources, env wins:
 *   1. ADMIN_PASSWORD environment variable (optional)
 *   2. a password created on first visit via /api/auth, stored (hashed) in KV
 *
 * When neither exists the endpoints return 428 so the UI can show the
 * "create your admin password" flow instead of a login prompt.
 */

export function hashPassword(pw: string): string {
  return createHash("sha256").update("tpx-admin:" + pw).digest("hex");
}

/** Used when neither ADMIN_PASSWORD env nor a KV-stored password exists.
 *  Change it by setting the ADMIN_PASSWORD environment variable in Vercel. */
export const DEFAULT_ADMIN_PASSWORD = "123456789";

export type AuthMode = "env" | "kv" | "default";

export async function adminAuthMode(): Promise<AuthMode> {
  if (process.env.ADMIN_PASSWORD) return "env";
  try {
    if (await getAdminPasswordHash()) return "kv";
  } catch {
    // the store is unreachable; requireAdmin reports that properly, and this
    // only decides which login prompt to draw
  }
  return "default";
}

/** Message for a store that cannot be read. The password lives there, so this
 *  is not a 401 - the credentials were never checked at all, and calling it
 *  "wrong password" sends the user off resetting a password that is fine. */
function storeDown(err: unknown): NextResponse {
  return NextResponse.json(
    {
      error:
        `資料庫（Upstash KV）連線失敗，無法驗證密碼：${(err as Error).message}。` +
        `若資料庫已停用或額度用盡，可先在 Vercel 設定 ADMIN_PASSWORD 環境變數登入 —— ` +
        `環境變數不需要讀取資料庫。`,
      storeDown: true,
    },
    { status: 503 }
  );
}

export async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  const got = req.headers.get("x-admin-password") ?? "";
  // Checked first and without touching the store, so this stays a way in even
  // when the database is down.
  const envPw = process.env.ADMIN_PASSWORD;
  if (envPw) {
    if (got === envPw) return null;
    return NextResponse.json({ error: "密碼錯誤" }, { status: 401 });
  }
  let storedHash: string | null;
  try {
    storedHash = await getAdminPasswordHash();
  } catch (err) {
    return storeDown(err);
  }
  if (storedHash) {
    if (got && hashPassword(got) === storedHash) return null;
    return NextResponse.json({ error: "密碼錯誤" }, { status: 401 });
  }
  if (got === DEFAULT_ADMIN_PASSWORD) return null;
  return NextResponse.json({ error: "密碼錯誤" }, { status: 401 });
}
