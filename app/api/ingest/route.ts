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
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: {
    text?: string;
    chatId?: string | number;
    messageId?: number;
    timestamp?: number; // unix ms
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const text = (body.text ?? "").toString();
  if (!text.trim()) return NextResponse.json({ ok: true, skipped: "empty" });

  const settings = await getSettings();
  try {
    await handleIncomingMessage(
      text,
      {
        chatId: String(body.chatId ?? "listener"),
        messageId: Number(body.messageId ?? Date.now()),
        timestamp: Number(body.timestamp ?? Date.now()),
      },
      settings
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
