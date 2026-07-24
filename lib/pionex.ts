/**
 * Pionex REST client (HMAC-SHA256 signed), Web-Crypto-free: uses node:crypto,
 * which is available in Vercel's Node.js runtime for route handlers.
 *
 * IMPORTANT — perpetual futures live under a SEPARATE namespace:
 *   trade/account:  POST/DELETE/GET  /uapi/v1/trade/*  , /uapi/v1/account/*
 *   market/common:  GET              /uapi/v1/market/* , /uapi/v1/common/*
 * The futures TRADE symbol carries the _PERP suffix (e.g. BTC_USDT_PERP) and
 * orders take positionSide (BOTH for one-way mode). The old spot endpoints
 * (/api/v1/... + type=PERP) only ever returned market data for perp symbols and
 * REJECT perp orders, which is why they are kept solely as a read-only fallback.
 *
 * Signing (per Pionex API docs):
 *   1. add millisecond `timestamp` to query params
 *   2. sort query params by key, join as k=v&k=v
 *   3. message = METHOD + path + "?" + sortedQuery (+ exact JSON body for POST/DELETE)
 *   4. signature = hex(HMAC_SHA256(apiSecret, message))
 *   5. headers: PIONEX-KEY, PIONEX-SIGNATURE
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

// Perpetual-futures namespace (the one that actually accepts perp orders).
const FUTURES = {
  order: "/uapi/v1/trade/order",
  allOrders: "/uapi/v1/trade/allOrders",
  openOrders: "/uapi/v1/trade/openOrders",
  balances: "/uapi/v1/account/balances",
  symbols: "/uapi/v1/common/symbols",
  tickers: "/uapi/v1/market/tickers",
};

// Legacy spot-prefixed endpoints, used ONLY as a read fallback for market data
// (they return perp market data with ?type=PERP but reject perp orders).
const LEGACY = {
  balances: "/api/v1/account/balances",
  symbols: "/api/v1/common/symbols",
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

/** Number of decimal places implied by a numeric string like "0.001" -> 3. */
export function decimalsOf(v: string | number): number | null {
  const s = String(v);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** Round UP to `decimals` places (無條件進位), fp-safe. */
export function ceilToDecimals(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.ceil(v * f - 1e-9) / f;
}

/** Round DOWN to `decimals` places (無條件縮減/捨去), fp-safe. */
export function floorToDecimals(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.floor(v * f + 1e-9) / f;
}

export function toPerpSymbol(
  symbol: string,
  format = "{base}_{quote}"
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
    // Pionex perp TRADE symbol carries the _PERP suffix (BTC_USDT_PERP).
    private symbolFormat: string = "{base}_{quote}_PERP",
    // market type appended to the LEGACY fallback reads only.
    private marketType: string = "PERP"
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Normalized symbol ("BTCUSDT") -> Pionex perp contract symbol per config. */
  perpSymbol(symbol: string): string {
    return toPerpSymbol(symbol, this.symbolFormat);
  }

  private async signed(
    method: string,
    path: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
    addType = false
  ): Promise<Record<string, any>> {
    const allParams: Record<string, string> = {
      ...params,
      timestamp: String(Date.now()),
    };
    if (addType && this.marketType) allParams.type = this.marketType;
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

  private symbolInfo: Record<string, any> | null = null;

  /** Load & cache the perp symbol catalogue (futures common/symbols). */
  private async loadSymbolInfo(): Promise<Record<string, any>> {
    if (this.symbolInfo) return this.symbolInfo;
    let symbols: any[] = [];
    try {
      const p = await this.signed("GET", FUTURES.symbols);
      symbols = p?.data?.symbols ?? [];
    } catch {
      /* fall through to legacy */
    }
    if (!symbols.length) {
      try {
        const p = await this.signed("GET", LEGACY.symbols, {}, undefined, true);
        symbols = p?.data?.symbols ?? [];
      } catch {
        /* ignore - callers fall back to no rounding */
      }
    }
    const map: Record<string, any> = {};
    for (const s of symbols) if (s?.symbol) map[s.symbol] = s;
    this.symbolInfo = map;
    return map;
  }

  /** Look up catalogue info for a normalized ("BTCUSDT") or perp symbol. */
  private infoFor(symbolLike: string, map: Record<string, any>): any | null {
    const perp = this.perpSymbol(symbolLike);        // BTC_USDT_PERP
    return (
      map[perp] ??
      map[`${perp}_PERP`] ??
      map[symbolLike] ??
      map[`${symbolLike}_PERP`] ??
      null
    );
  }

  /** Price decimal places Pionex accepts for a symbol (null if unknown). */
  async pricePrecision(symbol: string): Promise<number | null> {
    try {
      const info = this.infoFor(symbol, await this.loadSymbolInfo());
      if (!info) return null;
      for (const f of ["quotePrecision", "pricePrecision", "quoteScale"]) {
        if (typeof info[f] === "number") return info[f];
      }
      for (const f of ["quoteStep", "tickSize", "minPrice", "priceTick"]) {
        if (info[f] != null) {
          const d = decimalsOf(info[f]);
          if (d != null) return d;
        }
      }
    } catch {
      /* ignore - caller falls back to no rounding */
    }
    return null;
  }

  /** Order filters (step sizes + minimum order size) for a symbol. */
  async orderFilters(symbol: string): Promise<{
    baseDecimals: number | null;   // qty decimal places (from baseStep/precision)
    quoteDecimals: number | null;  // price decimal places (from quoteStep/precision)
    minSizeLimit: number | null;
    minSizeMarket: number | null;
    minNotional: number | null;
  }> {
    const info = this.infoFor(symbol, await this.loadSymbolInfo().catch(() => ({})));
    if (!info)
      return { baseDecimals: null, quoteDecimals: null, minSizeLimit: null, minSizeMarket: null, minNotional: null };
    const num = (v: any) => (v == null ? null : Number(v));
    const dec = (v: any, p: any) =>
      v != null ? decimalsOf(v) : typeof p === "number" ? p : null;
    return {
      baseDecimals: dec(info.baseStep, info.basePrecision),
      quoteDecimals: dec(info.quoteStep, info.quotePrecision),
      minSizeLimit: num(info.minSizeLimit ?? info.minTradeSize),
      minSizeMarket: num(info.minSizeMarket ?? info.minSizeLimit ?? info.minTradeSize),
      minNotional: num(info.minNotional ?? info.minAmount),
    };
  }

  /** Quantity (base asset) decimal places Pionex accepts (null if unknown). */
  async basePrecision(symbol: string): Promise<number | null> {
    try {
      const info = this.infoFor(symbol, await this.loadSymbolInfo());
      if (!info) return null;
      for (const f of ["basePrecision", "sizePrecision", "baseScale"]) {
        if (typeof info[f] === "number") return info[f];
      }
      for (const f of ["baseStep", "minTradeSize", "minSize", "stepSize"]) {
        if (info[f] != null) {
          const d = decimalsOf(info[f]);
          if (d != null) return d;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async getAvailableUsdt(): Promise<number> {
    let balances: any[] = [];
    try {
      const payload = await this.signed("GET", FUTURES.balances);
      balances = payload?.data?.balances ?? payload?.data ?? [];
    } catch {
      const payload = await this.signed("GET", LEGACY.balances, {}, undefined, true);
      balances = payload?.data?.balances ?? [];
    }
    const usdt = Array.isArray(balances)
      ? balances.find((b) => b.coin === "USDT" || b.currency === "USDT")
      : null;
    return usdt ? parseFloat(usdt.free ?? usdt.available ?? "0") : 0;
  }

  /** Latest price. `symbol` is the perp/trade symbol (e.g. BTC_USDT_PERP). */
  async getPrice(symbol: string): Promise<number> {
    const parse = (payload: Record<string, any>): number => {
      const tickers: any[] = payload?.data?.tickers ?? [];
      const t = tickers[0] ?? payload?.data ?? null;
      const v = t?.close ?? t?.last ?? t?.price ?? t?.lastPrice;
      const n = v == null ? NaN : parseFloat(v);
      if (!Number.isFinite(n)) throw new PionexApiError(`no ticker for ${symbol}`);
      return n;
    };
    try {
      return parse(await this.signed("GET", FUTURES.tickers, { symbol }));
    } catch {
      return parse(await this.signed("GET", LEGACY.tickers, { symbol }, undefined, true));
    }
  }

  async getOpenOrders(symbol: string): Promise<any[]> {
    const payload = await this.signed("GET", FUTURES.openOrders, { symbol });
    return payload?.data?.orders ?? [];
  }

  async placeOrder(opts: {
    symbol: string;                 // perp symbol e.g. BTC_USDT_PERP
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    size?: string;                  // base qty (futures orders are size-based)
    amount?: string;                // quote amount (rarely used on perp)
    price?: string;                 // LIMIT only
    reduceOnly?: boolean;           // set on closes
    clientOrderId?: string;
  }): Promise<Record<string, any>> {
    const body: Record<string, unknown> = {
      symbol: opts.symbol,
      positionSide: "BOTH",         // one-way mode
      side: opts.side,
      type: opts.type,
    };
    if (opts.size !== undefined) body.size = opts.size;
    if (opts.amount !== undefined) body.amount = opts.amount;
    if (opts.price !== undefined) body.price = opts.price;
    if (opts.reduceOnly) body.reduceOnly = true;
    if (opts.clientOrderId) body.clientOrderId = opts.clientOrderId;
    return this.signed("POST", FUTURES.order, {}, body);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<Record<string, any>> {
    return this.signed("DELETE", FUTURES.order, {}, { symbol, orderId });
  }

  /** Cancels every open order on the symbol; returns how many were cancelled. */
  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      await this.signed("DELETE", FUTURES.allOrders, {}, { symbol });
      return 1;
    } catch {
      // fallback: enumerate open orders and cancel individually
      const orders = await this.getOpenOrders(symbol).catch(() => []);
      let n = 0;
      for (const o of orders) {
        const id = String(o.orderId ?? o.id ?? "");
        if (!id) continue;
        await this.cancelOrder(symbol, id).catch(() => {});
        n++;
      }
      return n;
    }
  }
}
