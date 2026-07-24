/**
 * Authenticated (read-only) Pionex probe to discover the perpetual-futures
 * trading namespace. It signs GET requests to a set of candidate account /
 * positions / open-orders endpoints and reports each status code and a short
 * response snippet. NOTHING is placed or cancelled - every call is a GET, so
 * this is safe to run against a live key. Use the results to pin down the
 * correct perp order endpoint.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/store";
import { signRequest } from "@/lib/pionex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Perpetual futures live under the /uapi/v1 namespace (positionSide, _PERP
// symbols). Probe those read-only endpoints so we can confirm the account +
// order namespace the trade API actually accepts (whichever returns
// result:true is live). The old /api/v1 + type=PERP rows are kept for contrast
// (they serve perp MARKET DATA but reject perp orders). All GET / safe.
// [path, extraQueryParams]
const CANDIDATES: [string, Record<string, string>][] = [
  // futures namespace (the one that accepts perp orders)
  ["/uapi/v1/account/balances", {}],
  ["/uapi/v1/common/symbols", {}],
  ["/uapi/v1/market/tickers", { symbol: "BTC_USDT_PERP" }],
  ["/uapi/v1/trade/openOrders", { symbol: "BTC_USDT_PERP" }],
  ["/uapi/v1/trade/allOrders", { symbol: "BTC_USDT_PERP", limit: "1" }],
  ["/uapi/v1/account/positions", {}],
  ["/uapi/v1/trade/positions", {}],
  // legacy spot namespace (perp market data only; orders rejected)
  ["/api/v1/account/balances", { type: "PERP" }],
  ["/api/v1/trade/openOrders", { symbol: "BTC_USDT", type: "PERP" }],
];

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const settings = await getSettings();
  const { apiKey, apiSecret, baseUrl } = settings.pionex;
  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: "尚未設定 Pionex API 金鑰" }, { status: 400 });
  }
  const base = baseUrl.replace(/\/+$/, "");

  const results: any[] = [];
  for (const [path, extra] of CANDIDATES) {
    const params: Record<string, string> = {
      ...extra,
      timestamp: String(Date.now()),
    };
    const signature = signRequest(apiSecret, "GET", path, params);
    const query = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join("&");
    try {
      const r = await fetch(`${base}${path}?${query}`, {
        method: "GET",
        headers: { "PIONEX-KEY": apiKey, "PIONEX-SIGNATURE": signature },
        cache: "no-store",
      });
      const text = await r.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not json */
      }
      results.push({
        path,
        query: extra,
        status: r.status,
        result: parsed?.result ?? null,
        code: parsed?.code ?? null,
        message: parsed?.message ?? parsed?.error_msg ?? null,
        snippet: parsed ? undefined : text.slice(0, 160),
      });
    } catch (e) {
      results.push({ path, query: extra, error: (e as Error).message });
    }
  }

  return NextResponse.json({
    baseUrl: base,
    note:
      "看哪一列 result=true —— 那個 symbol 格式 + type 位置就是交易端點要的。" +
      "若全部 result=false，把每列的 code/message 截圖回報即可（不含金鑰，安全）。",
    results,
  });
}
