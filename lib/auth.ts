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
  if (await getAdminPasswordHash()) return "kv";
  return "default";
}

export async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  const got = req.headers.get("x-admin-password") ?? "";
  const envPw = process.env.ADMIN_PASSWORD;
  if (envPw) {
    if (got === envPw) return null;
    return NextResponse.json({ error: "密碼錯誤" }, { status: 401 });
  }
  const storedHash = await getAdminPasswordHash();
  if (storedHash) {
    if (got && hashPassword(got) === storedHash) return null;
    return NextResponse.json({ error: "密碼錯誤" }, { status: 401 });
  }
  if (got === DEFAULT_ADMIN_PASSWORD) return null;
  return NextResponse.json({ error: "密碼錯誤" }, { status: 401 });
}
