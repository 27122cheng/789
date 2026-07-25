/**
 * Win rate and profit, computed from the finished-trade history.
 *
 * Live and simulated trades are summarised separately: mixing them would make
 * the number meaningless, since dry-run fills are frictionless and always get
 * the price the monitor happened to see.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getTrades } from "@/lib/store";
import { TradeRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function summarise(trades: TradeRecord[]) {
  const n = trades.length;
  if (!n) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: null,
      totalPnl: 0, avgPnl: 0, avgWin: 0, avgLoss: 0,
      profitFactor: null, best: null, worst: null, avgR: null,
    };
  }
  const wins = trades.filter((t) => t.pnlUsdt > 0);
  const losses = trades.filter((t) => t.pnlUsdt < 0);
  const sum = (xs: TradeRecord[]) => xs.reduce((a, t) => a + t.pnlUsdt, 0);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const rs = trades.map((t) => t.rMultiple).filter((r): r is number => r != null);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: +((wins.length / n) * 100).toFixed(1),
    totalPnl: +sum(trades).toFixed(4),
    avgPnl: +(sum(trades) / n).toFixed(4),
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(4) : 0,
    avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(4) : 0,
    // >1 means the wins outweigh the losses; null when nothing has lost yet
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    best: +Math.max(...trades.map((t) => t.pnlUsdt)).toFixed(4),
    worst: +Math.min(...trades.map((t) => t.pnlUsdt)).toFixed(4),
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : null,
  };
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const all = await getTrades();
  const live = all.filter((t) => !t.dryRun);
  const dry = all.filter((t) => t.dryRun);

  // per-symbol breakdown of real trades, worst first so problems stand out
  const bySymbol: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const t of live) {
    const e = (bySymbol[t.symbol] ??= { trades: 0, wins: 0, pnl: 0 });
    e.trades += 1;
    if (t.pnlUsdt > 0) e.wins += 1;
    e.pnl = +(e.pnl + t.pnlUsdt).toFixed(4);
  }

  return NextResponse.json({
    live: summarise(live),
    dry: summarise(dry),
    bySymbol: Object.entries(bySymbol)
      .map(([symbol, v]) => ({
        symbol,
        ...v,
        winRate: +((v.wins / v.trades) * 100).toFixed(1),
      }))
      .sort((a, b) => a.pnl - b.pnl),
    recent: all.slice(0, 100),
  });
}
