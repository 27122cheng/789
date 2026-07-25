/** Empties the finished-trade history (and with it the win-rate stats). */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { clearTrades } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  await clearTrades();
  return NextResponse.json({ ok: true });
}
