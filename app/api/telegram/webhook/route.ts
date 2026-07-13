/**
 * Telegram Bot webhook receiver. Telegram POSTs every update here after
 * /api/setup-webhook registers the URL. Authenticity is checked via the
 * x-telegram-bot-api-secret-token header (set during setWebhook).
 *
 * Every update is recorded to the webhook diagnostic log (accepted or not)
 * so the dashboard can show whether Telegram is delivering anything and why
 * a message was dropped - the #1 thing people need when "nothing detects".
 */
import { NextRequest, NextResponse } from "next/server";
import { handleIncomingMessage } from "@/lib/executor";
import { appendWebhookEvent, getSettings } from "@/lib/store";
import { WebhookEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}
interface TgChat {
  id: number;
  type?: string;
  username?: string;
  title?: string;
}
interface TgMessage {
  message_id: number;
  date: number; // unix seconds
  text?: string;
  caption?: string;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
}

function chatAllowed(chat: TgChat, allowed: string[]): boolean {
  // Empty whitelist = accept every chat the bot is in. The bot only receives
  // updates from chats it has been added to, so this is a safe, friendly
  // default that removes the "my chat id doesn't match" failure mode.
  if (!allowed.length) return true;
  const id = String(chat.id);
  const username = (chat.username ?? "").toLowerCase();
  const title = (chat.title ?? "").toLowerCase();
  return allowed.some((entry) => {
    const e = entry.trim().replace(/^@/, "").toLowerCase();
    return e && (e === id || e === username || e === title);
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

  const updateType =
    Object.keys(update).find((k) => k !== "update_id") ?? "unknown";
  const message: TgMessage | undefined =
    update.message ??
    update.channel_post ??
    (settings.telegram.reactToEdits
      ? update.edited_message ?? update.edited_channel_post
      : undefined);

  const ev: WebhookEvent = {
    at: Date.now(),
    updateType,
    chatId: message ? String(message.chat.id) : null,
    chatTitle: message?.chat.title ?? null,
    chatType: message?.chat.type ?? null,
    chatUsername: message?.chat.username ?? null,
    fromBot: !!message?.from?.is_bot,
    outcome: "unsupported",
    detail: "",
    textPreview: "",
  };

  try {
    if (!message) {
      ev.outcome = "unsupported";
      ev.detail = `update type "${updateType}" is not a message`;
      await appendWebhookEvent(ev);
      return NextResponse.json({ ok: true });
    }

    const text = message.text ?? message.caption ?? "";
    ev.textPreview = text.slice(0, 160);

    if (!text.trim()) {
      ev.outcome = "empty_text";
      ev.detail = "message has no text/caption (sticker, photo, etc.)";
      await appendWebhookEvent(ev);
      return NextResponse.json({ ok: true });
    }

    if (!chatAllowed(message.chat, settings.telegram.allowedChats)) {
      ev.outcome = "chat_not_allowed";
      ev.detail =
        `chat ${message.chat.id} (${message.chat.title ?? message.chat.username ?? "?"}) ` +
        `is not in the allow-list; add it or clear the list to accept all`;
      await appendWebhookEvent(ev);
      return NextResponse.json({ ok: true });
    }

    ev.outcome = "accepted";
    ev.detail = ev.fromBot
      ? "sender is a bot (delivered because it posted via channel or privacy off)"
      : "forwarded to signal handler";
    await appendWebhookEvent(ev);

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
    ev.outcome = "error";
    ev.detail = (err as Error).message;
    try {
      await appendWebhookEvent(ev);
    } catch {
      /* ignore */
    }
    // Never bubble a 5xx to Telegram - it would redeliver the same update.
    console.error("webhook handling failed:", err);
  }
  return NextResponse.json({ ok: true });
}
