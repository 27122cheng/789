import { NextRequest, NextResponse } from "next/server";
import { adminAuthMode, requireAdmin } from "@/lib/auth";
import {
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

  const [settings, positions, signals, orders] = await Promise.all([
    getSettings(),
    getPositions(),
    getSignals(),
    getOrders(),
  ]);

  return NextResponse.json({
    authMode: await adminAuthMode(),
    liveTrading:
      settings.trading.liveTrading &&
      !!settings.pionex.apiKey &&
      !!settings.pionex.apiSecret,
    trailingEnabled: settings.trading.trailing.enabled,
    durableStore: hasDurableStore(),
    configured: {
      telegramBot: !!settings.telegram.botToken,
      allowedChats: settings.telegram.allowedChats.length,
      pionexKeys: !!settings.pionex.apiKey && !!settings.pionex.apiSecret,
    },
    positions,
    signals: signals.slice(0, 50),
    orders: orders.slice(0, 50),
  });
}
