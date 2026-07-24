/**
 * Clears the order/action log and the received-signals log (the dashboard
 * lists). Does not touch positions or settings.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { clearLogs } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  await clearLogs();
  return NextResponse.json({ ok: true });
}
