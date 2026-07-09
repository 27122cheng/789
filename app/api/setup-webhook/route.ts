/**
 * Registers this deployment's /api/telegram/webhook URL with the Telegram
 * Bot API (setWebhook), using the secret token stored in settings. Call it
 * once after saving the bot token (the settings page has a button for this).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/store";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const settings = await getSettings();
  if (!settings.telegram.botToken) {
    return NextResponse.json(
      { error: "botToken is not set - save it in settings first" },
      { status: 400 }
    );
  }
  if (!settings.telegram.webhookSecret) {
    settings.telegram.webhookSecret = randomBytes(24).toString("hex");
    await saveSettings(settings);
  }

  const origin =
    req.headers.get("x-forwarded-host")
      ? `https://${req.headers.get("x-forwarded-host")}`
      : new URL(req.url).origin;
  const webhookUrl = `${origin}/api/telegram/webhook`;

  const resp = await fetch(
    `https://api.telegram.org/bot${settings.telegram.botToken}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: settings.telegram.webhookSecret,
        allowed_updates: [
          "message", "edited_message", "channel_post", "edited_channel_post",
        ],
      }),
    }
  );
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || !payload.ok) {
    return NextResponse.json(
      { error: `Telegram setWebhook failed: ${payload.description ?? resp.status}` },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, webhookUrl });
}
