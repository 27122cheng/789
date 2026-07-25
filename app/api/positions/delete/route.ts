/**
 * Deletes ONE tracked position, for the per-row ✕ on the dashboard.
 * Like /clear, this removes the bot's own record; a real position on the
 * exchange (and its protective orders) is left untouched. See dropPosition().
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { dropPosition } from "@/lib/executor";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let symbol = "";
  try {
    symbol = String((await req.json())?.symbol ?? "").toUpperCase().trim();
  } catch {
    /* handled below as a missing symbol */
  }
  if (!symbol) {
    return NextResponse.json({ error: "缺少 symbol" }, { status: 400 });
  }

  const result = await dropPosition(symbol, await getSettings());
  if (!result.found) {
    return NextResponse.json({ error: `找不到持倉紀錄 ${symbol}` }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...result });
}
