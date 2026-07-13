/**
 * Telegram connectivity diagnostics. Calls the Bot API's getWebhookInfo and
 * getMe so the dashboard can show, in one place:
 *   - is the webhook registered, and to the right URL?
 *   - how many updates are pending / stuck?
 *   - what was the last delivery error Telegram saw?
 *   - is the bot token even valid?
 * Combined with the raw webhook event log, this pinpoints why "nothing
 * detects" without the user having to dig through Telegram or Vercel logs.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSettings, getWebhookEvents } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const settings = await getSettings();
  const token = settings.telegram.botToken;
  const events = await getWebhookEvents();

  if (!token) {
    return NextResponse.json({
      botToken: false,
      events,
      hint: "尚未填入 Bot Token",
    });
  }

  const origin = req.headers.get("x-forwarded-host")
    ? `https://${req.headers.get("x-forwarded-host")}`
    : new URL(req.url).origin;
  const expectedUrl = `${origin}/api/telegram/webhook`;

  async function tg(method: string) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        cache: "no-store",
      });
      return await r.json();
    } catch (e) {
      return { ok: false, description: (e as Error).message };
    }
  }

  const [me, info] = await Promise.all([tg("getMe"), tg("getWebhookInfo")]);

  const wh = info?.result ?? {};
  const registered = !!wh.url;
  const urlMatches = wh.url === expectedUrl;

  const problems: string[] = [];
  if (me?.ok === false) problems.push("Bot Token 無效，請重新確認 @BotFather 給的 token");
  if (!registered) problems.push("Webhook 尚未註冊，請到設定頁按「註冊 Telegram Webhook」");
  else if (!urlMatches)
    problems.push(
      `Webhook 目前指向 ${wh.url}，與這個網站 ${expectedUrl} 不同；請重新註冊`
    );
  if (wh.last_error_message)
    problems.push(`Telegram 最近一次送信錯誤：${wh.last_error_message}`);
  if ((wh.pending_update_count ?? 0) > 0)
    problems.push(`有 ${wh.pending_update_count} 筆更新積壓未處理`);
  if (settings.telegram.allowedChats.length === 0)
    problems.push(
      "監聽群組清單是空的：目前設定為「接受所有群組」。若完全沒收到訊息，代表機器人根本沒被加進發信號的群組，或訊號來自另一個機器人（機器人看不到其他機器人的訊息）。"
    );

  return NextResponse.json({
    botToken: true,
    botUsername: me?.result?.username ?? null,
    expectedUrl,
    webhook: {
      url: wh.url ?? null,
      registered,
      urlMatches,
      pendingUpdateCount: wh.pending_update_count ?? 0,
      lastErrorMessage: wh.last_error_message ?? null,
      lastErrorDate: wh.last_error_date ?? null,
      maxConnections: wh.max_connections ?? null,
      allowedUpdates: wh.allowed_updates ?? null,
    },
    problems,
    events,
  });
}
