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

// [path, extraQueryParams]
const CANDIDATES: [string, Record<string, string>][] = [
  ["/api/v1/account/balances", {}],
  ["/api/v1/account/balances", { type: "PERP" }],
  ["/api/v1/futures/balances", {}],
  ["/api/v1/futures/account", {}],
  ["/api/v1/futures/positions", {}],
  ["/api/v1/account/positions", { type: "PERP" }],
  ["/api/v1/futures/openOrders", { symbol: "BTC_USDT_PERP" }],
  ["/api/v1/trade/openOrders", { symbol: "BTC_USDT_PERP", type: "PERP" }],
  ["/api/v1/futures/trade/openOrders", { symbol: "BTC_USDT_PERP" }],
  ["/api/v1/perpetual/positions", {}],
  ["/api/v1/contract/positions", {}],
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
      results.push({
        path,
        query: extra,
        status: r.status,
        snippet: text.slice(0, 220),
      });
    } catch (e) {
      results.push({ path, query: extra, error: (e as Error).message });
    }
  }

  return NextResponse.json({
    baseUrl: base,
    note:
      "找 status=200 且回傳看起來像帳戶/持倉/掛單資料的那個 path，" +
      "就是永續合約的正確命名空間。把這個結果截圖回報即可（不含金鑰，安全）。",
    results,
  });
}
