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

  return NextResponse.json({
    baseUrl: base,
    currentSymbolFormat: settings.pionex.symbolFormat,
    hint:
      "看 sampleSymbols / matchingSymbols 裡實際的字串長怎樣（例如 BTC_USDT 或 BTC_USDT_PERP），" +
      "到設定頁把「合約代碼格式」改成對應的樣板即可。",
    matchingSymbols: matching,
    endpoints: results,
  });
}
