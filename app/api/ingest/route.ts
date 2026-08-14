/**
 * Ingest endpoint for the user-account listener (listener/app.py).
 *
 * A Telegram BOT cannot read messages posted by another bot (Telegram's
 * anti-loop rule), so signals auto-posted by 加密掃描 Pro never reach the
 * /api/telegram/webhook. The listener logs in with the USER's own account
 * (Telethon/MTProto), which CAN see everything, and forwards each channel
 * message here. This runs the exact same parse + execute pipeline as the
 * webhook, so all trading logic, settings, and the dashboard are unchanged.
 *
 * Auth: the admin password (x-admin-password header), same as the other
 * management endpoints. The listener holds it in an env var.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { handleIncomingMessage } from "@/lib/executor";
import { appendWebhookEvent, getSettings } from "@/lib/store";
import { chatAllowed } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: {
    text?: string;
    chatId?: string | number;
    chatTitle?: string | null;
    chatUsername?: string | null;
    messageId?: number;
    timestamp?: number; // unix ms
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const text = (body.text ?? "").toString();
  const chatId = String(body.chatId ?? "listener");

  // Every delivery is logged to the same diagnostic list the bot webhook uses.
  // Without this the listener - the path signals ACTUALLY arrive by - left no
  // trace at all, so "nothing is trading" could not be told apart from
  // "nothing is arriving", and the diagnostics page showed only bot traffic.
  const chatTitle = body.chatTitle ?? null;
  const ev = {
    at: Date.now(),
    updateType: "listener",
    chatId,
    chatTitle,
    chatType: "listener" as const,
    chatUsername: body.chatUsername ?? null,
    fromBot: false,
    outcome: "accepted" as const,
    detail: "由監聽器（你的 Telegram 帳號）轉送",
    textPreview: text.slice(0, 160),
  };

  if (!text.trim()) {
    await appendWebhookEvent({ ...ev, outcome: "empty_text", detail: "監聽器送來的訊息沒有文字" });
    return NextResponse.json({ ok: true, skipped: "empty" });
  }

  const settings = await getSettings();

  // The listener is signed in as the USER, so it can see every group they
  // belong to - not just the one carrying signals. Without this check anything
  // signal-shaped in ANY chat was traded. The bot webhook has always filtered
  // here; this path simply never did.
  if (
    !chatAllowed(
      { id: chatId, username: body.chatUsername, title: chatTitle },
      settings.telegram.allowedChats
    )
  ) {
    await appendWebhookEvent({
      ...ev,
      outcome: "chat_not_allowed",
      detail:
        `群組 ${chatId}${chatTitle ? `（${chatTitle}）` : ""} 不在「監聽群組」清單中，已忽略。` +
        `要交易這個群組的訊號，請到設定把它加入清單`,
    });
    return NextResponse.json({ ok: true, skipped: "chat_not_allowed" });
  }
  try {
    await handleIncomingMessage(
      text,
      {
        chatId,
        messageId: Number(body.messageId ?? Date.now()),
        timestamp: Number(body.timestamp ?? Date.now()),
      },
      settings
    );
  } catch (err) {
    const msg = (err as Error).message;
    await appendWebhookEvent({ ...ev, outcome: "error", detail: `處理失敗：${msg}` });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  await appendWebhookEvent(ev);
  return NextResponse.json({ ok: true });
}
