/**
 * Takes an untracked exchange position back under management, for the 接管
 * button on the dashboard's untracked-positions warning. Places and cancels
 * nothing - see adoptPosition().
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { adoptPosition } from "@/lib/executor";
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

  try {
    const result = await adoptPosition(symbol, await getSettings());
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: `接管失敗：${(e as Error).message}` },
      { status: 502 }
    );
  }
}
