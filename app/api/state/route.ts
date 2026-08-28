import { NextRequest, NextResponse } from "next/server";
import { adminAuthMode, requireAdmin } from "@/lib/auth";
import { getStateBundle, hasDurableStore } from "@/lib/store";

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
  try {
    return await buildState();
  } catch (err) {
    // An opaque 500 here reads as "the app is broken" when the usual cause is
    // simply that the KV store cannot be reached.
    return NextResponse.json(
      {
        error: `讀取資料失敗：${(err as Error).message}（多半是 Upstash KV 連線問題）`,
        storeDown: true,
      },
      { status: 503 }
    );
  }
}

async function buildState() {
  // one Redis command for the whole page - this endpoint is polled, so its
  // per-call cost decides whether the free KV tier survives the month
  const { settings, positions, signals, orders, monitorRun, stopSnapshot, untracked } =
    await getStateBundle();

  const exchangeKeys =
    settings.exchange === "okx"
      ? !!settings.okx.apiKey && !!settings.okx.apiSecret && !!settings.okx.passphrase
      : !!settings.pionex.apiKey && !!settings.pionex.apiSecret;

  const stops = stopSnapshot?.bySymbol
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
    untracked: untracked?.positions
      ? {
          at: untracked.at,
          positions: untracked.positions.map((p) => ({
            ...p,
            symbol: normalizeVenueSymbol(p.symbol),
          })),
        }
      : null,
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
