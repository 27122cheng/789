/**
 * Clears the bot's tracked positions. Handy for wiping simulated positions
 * that accumulate in dry-run. NOTE: this only clears the bot's own tracker -
 * it does NOT close any real position on Pionex. In live mode, close real
 * positions on the exchange yourself.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getPositions, savePositions } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const cleared = Object.keys(await getPositions()).length;
  await savePositions({});
  return NextResponse.json({ ok: true, cleared });
}
