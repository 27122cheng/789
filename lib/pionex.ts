/**
 * Pionex REST client (HMAC-SHA256 signed), Web-Crypto-free: uses node:crypto,
 * which is available in Vercel's Node.js runtime for route handlers.
 *
 * Signing (per Pionex API docs):
 *   1. add millisecond `timestamp` to query params
 *   2. sort query params by key, join as k=v&k=v
 *   3. message = METHOD + path + "?" + sortedQuery (+ exact JSON body for POST/DELETE)
 *   4. signature = hex(HMAC_SHA256(apiSecret, message))
 *   5. headers: PIONEX-KEY, PIONEX-SIGNATURE
 *
 * IMPORTANT: verify endpoint paths and the futures symbol format (e.g.
 * "BTC_USDT_PERP") against https://pionex-doc.gitbook.io/apidocs before
 * enabling live trading; they are constructor options so they can be fixed
 * from configuration rather than code.
 */
import { createHmac } from "node:crypto";

export class PionexApiError extends Error {
  status?: number;
  payload?: Record<string, unknown>;
  constructor(message: string, status?: number, payload?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export interface PionexPaths {
  balances: string;
  order: string;
  openOrders: string;
  tickers: string;
}

const DEFAULT_PATHS: PionexPaths = {
  balances: "/api/v1/account/balances",
  order: "/api/v1/trade/order",
  openOrders: "/api/v1/trade/openOrders",
  tickers: "/api/v1/market/tickers",
};

export function signRequest(
  apiSecret: string,
  method: string,
  path: string,
  params: Record<string, string>,
  body?: string
): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  let message = method.toUpperCase() + path + "?" + query;
  if (body) message += body;
  return createHmac("sha256", apiSecret).update(message).digest("hex");
}

export function toPerpSymbol(
  symbol: string,
  format = "{base}_{quote}_PERP"
): string {
  const s = symbol.toUpperCase().replace(/[-/_]/g, "");
  let base = s;
  let quote = "USDT";
  for (const q of ["USDT", "USDC", "BUSD", "USD"]) {
    if (s.endsWith(q) && s.length > q.length) {
      base = s.slice(0, -q.length);
      quote = q;
      break;
    }
  }
  return format.replace("{base}", base).replace("{quote}", quote);
}

export class PionexClient {
  constructor(
    private apiKey: string,
    private apiSecret: string,
    private baseUrl: string = "https://api.pionex.com",
    private symbolFormat: string = "{base}_{quote}_PERP",
    private paths: PionexPaths = DEFAULT_PATHS
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Normalized symbol ("BTCUSDT") -> Pionex contract symbol per config. */
  perpSymbol(symbol: string): string {
    return toPerpSymbol(symbol, this.symbolFormat);
  }

  private async request(
    method: string,
    path: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>
  ): Promise<Record<string, any>> {
    const allParams: Record<string, string> = {
      ...params,
      timestamp: String(Date.now()),
    };
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const signature = signRequest(this.apiSecret, method, path, allParams, bodyStr);

    const query = Object.keys(allParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
      .join("&");
    const url = `${this.baseUrl}${path}?${query}`;

    const headers: Record<string, string> = {
      "PIONEX-KEY": this.apiKey,
      "PIONEX-SIGNATURE": signature,
    };
    if (bodyStr !== undefined) headers["Content-Type"] = "application/json";

    const resp = await fetch(url, { method: method.toUpperCase(), headers, body: bodyStr });
    let payload: Record<string, any>;
    try {
      payload = await resp.json();
    } catch {
      throw new PionexApiError(`non-JSON response (HTTP ${resp.status})`, resp.status);
    }
    if (!resp.ok || payload.result === false) {
      throw new PionexApiError(
        `Pionex API error (HTTP ${resp.status}): ${payload.code ?? ""} ${payload.message ?? ""}`,
        resp.status,
        payload
      );
    }
    return payload;
  }

  async getAvailableUsdt(): Promise<number> {
    const payload = await this.request("GET", this.paths.balances);
    const balances: any[] = payload?.data?.balances ?? [];
    const usdt = balances.find((b) => b.coin === "USDT");
    return usdt ? parseFloat(usdt.free ?? "0") : 0;
  }

  /** Public endpoint - price of e.g. BTC_USDT_PERP. */
  async getPrice(symbol: string): Promise<number> {
    const payload = await this.request("GET", this.paths.tickers, { symbol });
    const tickers: any[] = payload?.data?.tickers ?? [];
    if (!tickers.length) throw new PionexApiError(`no ticker for ${symbol}`);
    return parseFloat(tickers[0].close);
  }

  async getOpenOrders(symbol: string): Promise<any[]> {
    const payload = await this.request("GET", this.paths.openOrders, { symbol });
    return payload?.data?.orders ?? [];
  }

  async placeOrder(opts: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    size?: string;    // base qty (LIMIT, MARKET SELL)
    amount?: string;  // quote amount (MARKET BUY)
    price?: string;   // LIMIT only
    clientOrderId?: string;
  }): Promise<Record<string, any>> {
    const body: Record<string, unknown> = {
      symbol: opts.symbol,
      side: opts.side,
      type: opts.type,
    };
    if (opts.size !== undefined) body.size = opts.size;
    if (opts.amount !== undefined) body.amount = opts.amount;
    if (opts.price !== undefined) body.price = opts.price;
    if (opts.clientOrderId) body.clientOrderId = opts.clientOrderId;
    return this.request("POST", this.paths.order, {}, body);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<Record<string, any>> {
    return this.request("DELETE", this.paths.order, {}, { symbol, orderId });
  }

  /** Cancels every open order on the symbol; returns how many were cancelled. */
  async cancelAllOrders(symbol: string): Promise<number> {
    const orders = await this.getOpenOrders(symbol);
    let n = 0;
    for (const o of orders) {
      const id = String(o.orderId ?? o.id ?? "");
      if (!id) continue;
      await this.cancelOrder(symbol, id);
      n++;
    }
    return n;
  }
}
