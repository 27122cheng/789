import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireAdmin } from "@/lib/auth";
import {
  getOrCreateCronSecret,
  getSettings,
  hasDurableStore,
  saveSettings,
} from "@/lib/store";
import { Settings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function masked(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "******";
  return value.slice(0, 3) + "****" + value.slice(-3);
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const settings = await getSettings();
  // never send raw secrets back to the browser
  const safe = structuredClone(settings) as Settings;
  safe.telegram.botToken = masked(settings.telegram.botToken);
  safe.pionex.apiKey = masked(settings.pionex.apiKey);
  safe.pionex.apiSecret = masked(settings.pionex.apiSecret);
  safe.telegram.webhookSecret = settings.telegram.webhookSecret ? "(set)" : "";
  const origin = req.headers.get("x-forwarded-host")
    ? `https://${req.headers.get("x-forwarded-host")}`
    : new URL(req.url).origin;
  return NextResponse.json({
    settings: safe,
    durableStore: hasDurableStore(),
    monitor: {
      url: `${origin}/api/cron/monitor`,
      secret: process.env.CRON_SECRET ?? (await getOrCreateCronSecret()),
    },
  });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: Partial<Settings>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const current = await getSettings();
  const next = structuredClone(current);

  // merge submitted fields; a masked/empty secret means "keep the stored one"
  if (body.telegram) {
    const t = body.telegram;
    if (typeof t.botToken === "string" && t.botToken && !t.botToken.includes("****"))
      next.telegram.botToken = t.botToken.trim();
    if (Array.isArray(t.allowedChats))
      next.telegram.allowedChats = t.allowedChats.map(String).filter(Boolean);
    if (typeof t.reactToEdits === "boolean")
      next.telegram.reactToEdits = t.reactToEdits;
  }
  if (body.pionex) {
    const p = body.pionex;
    if (typeof p.apiKey === "string" && p.apiKey && !p.apiKey.includes("****"))
      next.pionex.apiKey = p.apiKey.trim();
    if (typeof p.apiSecret === "string" && p.apiSecret && !p.apiSecret.includes("****"))
      next.pionex.apiSecret = p.apiSecret.trim();
    if (typeof p.baseUrl === "string" && p.baseUrl)
      next.pionex.baseUrl = p.baseUrl.trim();
  }
  if (body.trading) next.trading = { ...next.trading, ...body.trading };
  if (body.filters) next.filters = { ...next.filters, ...body.filters };

  if (!next.telegram.webhookSecret) {
    next.telegram.webhookSecret = randomBytes(24).toString("hex");
  }

  await saveSettings(next);
  return NextResponse.json({ ok: true, durableStore: hasDurableStore() });
}
