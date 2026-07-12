/**
 * Monitor tick: trailing-stop ratchet + soft SL/TP enforcement for tracked
 * positions. Trigger it every minute:
 *   - Vercel Cron (vercel.json) - note the Hobby plan only allows daily
 *     crons, which is useless for trading; or
 *   - an external pinger (cron-job.org, UptimeRobot, ...) calling
 *     GET /api/cron/monitor with header  authorization: Bearer <CRON_SECRET>
 *
 * Set the CRON_SECRET environment variable; Vercel Cron sends it
 * automatically, external pingers must be configured to send it.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { monitorTick } from "@/lib/executor";
import { getOrCreateCronSecret, getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // accepted credentials: CRON_SECRET env var, the auto-generated secret
  // shown on the settings page, or the admin password header (manual tests)
  const auth = req.headers.get("authorization") ?? "";
  const envSecret = process.env.CRON_SECRET;
  const kvSecret = await getOrCreateCronSecret();
  const bearerOk =
    (envSecret && auth === `Bearer ${envSecret}`) ||
    (kvSecret && auth === `Bearer ${kvSecret}`);
  if (!bearerOk) {
    const adminDenied = await requireAdmin(req);
    if (adminDenied) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const settings = await getSettings();
  const actions = await monitorTick(settings);
  return NextResponse.json({ ok: true, at: new Date().toISOString(), actions });
}
