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
import { getOrCreateCronSecret, getSettings, setMonitorRun } from "@/lib/store";

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

  // The listener piggybacks its own health onto this call it already makes
  // every minute, so the dashboard learns whether it is logged in without an
  // extra KV write or a second endpoint.
  const q = req.nextUrl.searchParams;
  const listener = q.has("listener")
    ? {
        authorized: q.get("authorized") === "1",
        watching: q.get("watching") === "1",
        chats: Number(q.get("chats") ?? "0") || 0,
        forwarded: Number(q.get("forwarded") ?? "0") || 0,
      }
    : null;

  const settings = await getSettings();
  // Record every run, success or failure: a silent dashboard otherwise looks
  // the same whether the monitor is healthy, erroring, or never being called.
  try {
    const actions = await monitorTick(settings);
    await setMonitorRun({
      at: Date.now(),
      actionCount: actions.length,
      actions: actions.slice(0, 20),
      error: null,
      listener,
    });
    return NextResponse.json({ ok: true, at: new Date().toISOString(), actions });
  } catch (e) {
    const error = (e as Error).message;
    await setMonitorRun({ at: Date.now(), actionCount: 0, actions: [], error, listener });
    return NextResponse.json({ ok: false, at: new Date().toISOString(), error }, { status: 500 });
  }
}
