import { NextRequest, NextResponse } from "next/server";
import { adminAuthMode, requireAdmin } from "@/lib/auth";
import {
  getMonitorRun,
  getStopSnapshot,
  getOrders,
  getPositions,
  getSettings,
  getSignals,
  hasDurableStore,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The snapshot is keyed by the venue's own symbol (BTC-USDT-SWAP, BTC_USDT_PERP)
 *  while positions use the normalized form (BTCUSDT). Re-key here so the client
 *  can look protection up directly instead of reimplementing perpSymbol(). */
function normalizeVenueSymbol(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/(SWAP|PERP)$/, "");
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const [settings, positions, signals, orders, monitorRun, stopSnapshot] = await Promise.all([
    getSettings(),
    getPositions(),
    getSignals(),
    getOrders(),
    getMonitorRun(),
    getStopSnapshot(),
  ]);

  const exchangeKeys =
    settings.exchange === "okx"
      ? !!settings.okx.apiKey && !!settings.okx.apiSecret && !!settings.okx.passphrase
      : !!settings.pionex.apiKey && !!settings.pionex.apiSecret;

  const stops = stopSnapshot
    ? {
        at: stopSnapshot.at,
        bySymbol: Object.fromEntries(
          Object.entries(stopSnapshot.bySymbol).map(([venue, list]) => [
            normalizeVenueSymbol(venue),
            list,
          ])
        ),
      }
    : null;

  return NextResponse.json({
    authMode: await adminAuthMode(),
    exchange: settings.exchange,
    liveTrading: settings.trading.liveTrading && exchangeKeys,
    trailingEnabled: settings.trading.trailing.enabled,
    exchangeStops: settings.trading.orders.exchangeStops !== false,
    monitorRun,
    stopSnapshot: stops,
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
