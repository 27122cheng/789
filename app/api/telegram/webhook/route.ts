/**
 * Telegram Bot webhook receiver. Telegram POSTs every update here after
 * /api/setup-webhook registers the URL. Authenticity is checked via the
 * x-telegram-bot-api-secret-token header (set during setWebhook).
 */
import { NextRequest, NextResponse } from "next/server";
import { handleIncomingMessage } from "@/lib/executor";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TgChat {
  id: number;
  username?: string;
  title?: string;
}
interface TgMessage {
  message_id: number;
  date: number; // unix seconds
  text?: string;
  caption?: string;
  chat: TgChat;
}

function chatAllowed(chat: TgChat, allowed: string[]): boolean {
  if (!allowed.length) return false;
  const id = String(chat.id);
  const username = (chat.username ?? "").toLowerCase();
  return allowed.some((entry) => {
    const e = entry.trim().replace(/^@/, "").toLowerCase();
    return e && (e === id || e === username);
  });
}

export async function POST(req: NextRequest) {
  const settings = await getSettings();

  const secret = settings.telegram.webhookSecret;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: Record<string, any>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const message: TgMessage | undefined =
    update.message ??
    update.channel_post ??
    (settings.telegram.reactToEdits
      ? update.edited_message ?? update.edited_channel_post
      : undefined);

  // Always 200 for updates we skip, so Telegram doesn't retry forever.
  if (!message) return NextResponse.json({ ok: true });

  const text = message.text ?? message.caption ?? "";
  if (!text.trim()) return NextResponse.json({ ok: true });

  if (!chatAllowed(message.chat, settings.telegram.allowedChats)) {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleIncomingMessage(
      text,
      {
        chatId: String(message.chat.id),
        messageId: message.message_id,
        timestamp: message.date * 1000,
      },
      settings
    );
  } catch (err) {
    // Never bubble a 5xx to Telegram - it would redeliver the same update.
    console.error("webhook handling failed:", err);
  }
  return NextResponse.json({ ok: true });
}
