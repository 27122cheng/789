/**
 * (Re)registers this deployment's /api/telegram/webhook URL with the Telegram
 * Bot API. Pressing the button always forces a clean re-sync: it rotates to a
 * fresh secret, deletes any existing webhook, sets it again, and then reads
 * back getWebhookInfo so the response reflects Telegram's true state. This
 * guarantees the secret Telegram sends matches what the webhook validates,
 * eliminating the "401 Unauthorized" stale-secret failure for good.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/store";
import { deriveWebhookSecret } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const settings = await getSettings();
  const token = settings.telegram.botToken;
  if (!token) {
    return NextResponse.json(
      { error: "尚未填入 Bot Token，請先在設定頁儲存" },
      { status: 400 }
    );
  }

  // Deterministic secret derived from the bot token: registration and the
  // webhook validator always compute the same value, so they can never
  // desync (no reliance on KV write propagation). Persist it too so the
  // diagnostics/settings views stay consistent.
  const secret = deriveWebhookSecret(token);
  settings.telegram.webhookSecret = secret;
  await saveSettings(settings);

  const origin = req.headers.get("x-forwarded-host")
    ? `https://${req.headers.get("x-forwarded-host")}`
    : new URL(req.url).origin;
  const webhookUrl = `${origin}/api/telegram/webhook`;

  async function tg(method: string, body?: Record<string, unknown>) {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return r.json().catch(() => ({ ok: false, description: "non-JSON response" }));
  }

  // Clear any existing webhook first (keep pending updates so the queued
  // message still gets delivered once the new secret is in place).
  await tg("deleteWebhook", { drop_pending_updates: false });

  const setRes = await tg("setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: [
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
    ],
  });

  if (!setRes.ok) {
    return NextResponse.json(
      { error: `Telegram setWebhook 失敗：${setRes.description ?? "unknown"}` },
      { status: 502 }
    );
  }

  // Read back the true state so the UI can show it immediately.
  const infoRes = await tg("getWebhookInfo");
  const info = infoRes?.result ?? {};

  return NextResponse.json({
    ok: true,
    webhookUrl,
    registeredUrl: info.url ?? webhookUrl,
    pendingUpdateCount: info.pending_update_count ?? 0,
    lastErrorMessage: info.last_error_message ?? null,
  });
}
