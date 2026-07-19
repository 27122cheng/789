/**
 * Pionex 探測: discover the exchange's real contract-symbol format.
 *
 * The environment this code was written in can't reach Pionex, but the Vercel
 * deployment can (that's how live orders got a TRADE_INVALID_SYMBOL error).
 * This endpoint queries Pionex's PUBLIC market endpoints (no auth needed) and
 * returns the actual symbol strings, so the correct `symbolFormat` can be set
 * on the settings page. Optionally pass ?coin=BTC to filter.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANDIDATES = [
  "/api/v1/common/symbols",
  "/api/v1/common/symbols?type=PERP",
  "/api/v1/market/symbols",
  "/api/v1/market/tickers",
  "/api/v1/market/tickers?type=PERP",
];

function collectSymbols(payload: any): string[] {
  const out = new Set<string>();
  const walk = (v: any) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") {
      if (typeof v.symbol === "string") out.add(v.symbol);
      Object.values(v).forEach(walk);
    }
  };
  walk(payload?.data ?? payload);
  return [...out];
}

// full symbol objects (to reveal precision/tick fields)
function collectObjects(payload: any): any[] {
  const out: any[] = [];
  const walk = (v: any) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") {
      if (typeof v.symbol === "string") out.push(v);
      else Object.values(v).forEach(walk);
    }
  };
  walk(payload?.data ?? payload);
  return out;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const settings = await getSettings();
  const base = settings.pionex.baseUrl.replace(/\/+$/, "");
  const coin = (req.nextUrl.searchParams.get("coin") ?? "").toUpperCase();

  const results: any[] = [];
  let allSymbols: string[] = [];

  for (const path of CANDIDATES) {
    try {
      const r = await fetch(base + path, { cache: "no-store" });
      const text = await r.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      const symbols = json ? collectSymbols(json) : [];
      if (symbols.length) allSymbols = allSymbols.concat(symbols);
      results.push({
        path,
        status: r.status,
        ok: r.ok,
        symbolCount: symbols.length,
        sampleSymbols: symbols.slice(0, 12),
        rawPreview: symbols.length ? undefined : text.slice(0, 200),
      });
    } catch (e) {
      results.push({ path, error: (e as Error).message });
    }
  }

  const uniq = [...new Set(allSymbols)];
  const matching = coin
    ? uniq.filter((s) => s.toUpperCase().includes(coin))
    : uniq
        .filter((s) => /BTC|ETH|SOL/i.test(s))
        .slice(0, 30);

  // when a coin is given, show a couple of FULL objects so precision/tick
  // fields are visible (used to align prices to Pionex's tick size)
  let sampleObjects: any[] = [];
  if (coin) {
    for (const path of ["/api/v1/common/symbols?type=PERP", "/api/v1/common/symbols"]) {
      try {
        const r = await fetch(base + path, { cache: "no-store" });
        const j = await r.json();
        const objs = collectObjects(j).filter((o) =>
          String(o.symbol).toUpperCase().includes(coin)
        );
        if (objs.length) {
          sampleObjects = objs.slice(0, 3);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return NextResponse.json({
    baseUrl: base,
    currentSymbolFormat: settings.pionex.symbolFormat,
    hint:
      "看 sampleObjects 裡的精度欄位（basePrecision/quotePrecision/minTradeSize 等），" +
      "用來把價格與數量對齊 Pionex 的最小單位。",
    matchingSymbols: matching,
    sampleObjects,
    endpoints: results,
  });
}
