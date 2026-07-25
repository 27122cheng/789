import { NextRequest, NextResponse } from "next/server";
import { adminAuthMode, requireAdmin } from "@/lib/auth";
import {
  getMonitorRun,
  getOrders,
  getPositions,
  getSettings,
  getSignals,
  hasDurableStore,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const [settings, positions, signals, orders, monitorRun] = await Promise.all([
    getSettings(),
    getPositions(),
    getSignals(),
    getOrders(),
    getMonitorRun(),
  ]);

  const exchangeKeys =
    settings.exchange === "okx"
      ? !!settings.okx.apiKey && !!settings.okx.apiSecret && !!settings.okx.passphrase
      : !!settings.pionex.apiKey && !!settings.pionex.apiSecret;

  return NextResponse.json({
    authMode: await adminAuthMode(),
    exchange: settings.exchange,
    liveTrading: settings.trading.liveTrading && exchangeKeys,
    trailingEnabled: settings.trading.trailing.enabled,
    exchangeStops: settings.trading.orders.exchangeStops !== false,
    monitorRun,
    durableStore: hasDurableStore(),
    configured: {
      telegramBot: !!settings.telegram.botToken,
      allowedChats: settings.telegram.allowedChats.length,
      pionexKeys: exchangeKeys,
    },
    positions,
    signals: signals.slice(0, 100),
    orders: orders.slice(0, 100),
  });
}
