/**
 * OKX v5 REST client for USDT-margined perpetual swaps.
 *
 * Auth (per OKX docs):
 *   prehash   = OK-ACCESS-TIMESTAMP + METHOD + requestPath(+query) + body
 *   signature = base64(HMAC_SHA256(apiSecret, prehash))
 *   headers   = OK-ACCESS-KEY / -SIGN / -TIMESTAMP / -PASSPHRASE
 *   timestamp = ISO-8601 with milliseconds, e.g. 2020-12-08T09:08:57.715Z
 * Demo trading adds the header x-simulated-trading: 1.
 *
 * IMPORTANT - contract sizing: for SWAP instruments OKX denominates `sz` in
 * CONTRACTS, not coins. One BTC-USDT-SWAP contract is 0.01 BTC (ctVal). The
 * executor works in base-asset quantities, so this client converts
 * base -> contracts (and the instrument's limits back to base units) at its
 * boundary. Getting this backwards would size an order 100x wrong, so the
 * conversion lives in exactly one place: szFromBase().
 */
import { createHmac } from "node:crypto";
import {
  AttachRejectedError,
  ExchangeClient,
  OrderFilters,
  PlaceOrderOpts,
  PlacedOrder,
} from "./exchange";
import { decimalsOf, floorToStep } from "./num";

/** Decimal places of a computed step like 0.0001, without the trailing-zero
 *  artefacts of toFixed (a whole-number step must yield 0, not null). */
function stepDecimals(step: number): number | null {
  const s = step.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return decimalsOf(s);
}

export class OkxApiError extends Error {
  code?: string;
  payload?: Record<string, unknown>;
  constructor(message: string, code?: string, payload?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.payload = payload;
  }
}

/** "BTCUSDT" -> "BTC-USDT-SWAP" */
export function toOkxInstId(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[-/_]/g, "");
  let base = s;
  let quote = "USDT";
  for (const q of ["USDT", "USDC", "USD"]) {
    if (s.endsWith(q) && s.length > q.length) {
      base = s.slice(0, -q.length);
      quote = q;
      break;
    }
  }
  return `${base}-${quote}-SWAP`;
}

export function okxSign(
  apiSecret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body: string
): string {
  return createHmac("sha256", apiSecret)
    .update(timestamp + method.toUpperCase() + requestPath + body)
    .digest("base64");
}

export class OkxClient implements ExchangeClient {
  constructor(
    private apiKey: string,
    private apiSecret: string,
    private passphrase: string,
    private baseUrl: string = "https://www.okx.com",
    /** cross | isolated - margin mode used for every order */
    private tdMode: string = "cross",
    /** demo (paper) trading endpoint */
    private demo: boolean = false
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  perpSymbol(symbol: string): string {
    return toOkxInstId(symbol);
  }

  private async request(
    method: string,
    path: string,
    query: Record<string, string> = {},
    // cancel-algos takes a JSON array body; everything else an object
    body?: Record<string, unknown> | unknown[]
  ): Promise<any[]> {
    const qs = Object.keys(query)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join("&");
    const requestPath = qs ? `${path}?${qs}` : path;
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const timestamp = new Date().toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");

    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": okxSign(this.apiSecret, timestamp, method, requestPath, bodyStr),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json",
    };
    if (this.demo) headers["x-simulated-trading"] = "1";

    const resp = await fetch(`${this.baseUrl}${requestPath}`, {
      method: method.toUpperCase(),
      headers,
      body: bodyStr === "" ? undefined : bodyStr,
      cache: "no-store",
    });
    let payload: Record<string, any>;
    try {
      payload = await resp.json();
    } catch {
      throw new OkxApiError(`non-JSON response (HTTP ${resp.status})`);
    }
    // OKX reports business failures with code != "0" and HTTP 200.
    if (payload.code !== undefined && String(payload.code) !== "0") {
      const first = Array.isArray(payload.data) ? payload.data[0] : null;
      const detail = first?.sMsg || payload.msg || "";
      const code = first?.sCode || String(payload.code);
      throw new OkxApiError(`OKX API error (${code}): ${detail}`, code, payload);
    }
    return Array.isArray(payload.data) ? payload.data : [];
  }

  // ------------------------------------------------- instrument catalogue
  private instruments: Record<string, any> | null = null;

  private async loadInstruments(): Promise<Record<string, any>> {
    if (this.instruments) return this.instruments;
    const rows = await this.request("GET", "/api/v5/public/instruments", {
      instType: "SWAP",
    });
    const map: Record<string, any> = {};
    for (const r of rows) if (r?.instId) map[r.instId] = r;
    this.instruments = map;
    return map;
  }

  // ---------------------------------------------------- position mode
  private posModeCache: string | null = null;

  /** "long_short_mode" (雙向持倉, posSide required) or "net_mode" (單向持倉).
   *  Falls back to net mode if the account config can't be read. */
  private async posMode(): Promise<string> {
    if (this.posModeCache) return this.posModeCache;
    try {
      const rows = await this.request("GET", "/api/v5/account/config");
      this.posModeCache = rows[0]?.posMode || "net_mode";
    } catch {
      this.posModeCache = "net_mode";
    }
    return this.posModeCache!;
  }

  private async infoFor(symbolLike: string): Promise<any | null> {
    const instId = /-SWAP$/i.test(symbolLike) ? symbolLike : this.perpSymbol(symbolLike);
    try {
      return (await this.loadInstruments())[instId] ?? null;
    } catch {
      return null;
    }
  }

  /** Contracts for a base-asset quantity, snapped DOWN to the lot step and not
   *  lifted - so callers can tell "too small to place" from a valid size. */
  private contractsFor(info: any, baseQty: number): number {
    const ctVal = Number(info?.ctVal);
    const lotSz = Number(info?.lotSz);
    if (!Number.isFinite(ctVal) || ctVal <= 0) {
      // Unknown contract value: sending a raw base qty would be a silent
      // mis-size, so refuse rather than guess.
      throw new OkxApiError(
        `OKX 缺少 ${info?.instId ?? "此合約"} 的合約面值 (ctVal)，無法換算張數`
      );
    }
    const contracts = baseQty / ctVal;
    return Number.isFinite(lotSz) && lotSz > 0
      ? floorToStep(contracts, lotSz)
      : contracts;
  }

  private lotDecimals(info: any): number {
    return (info?.lotSz != null ? decimalsOf(info.lotSz) : 0) ?? 0;
  }

  /** Contracts for a base quantity, lifted to the venue minimum, formatted. */
  private szFromBase(info: any, baseQty: number): string {
    let contracts = this.contractsFor(info, baseQty);
    const minSz = Number(info?.minSz);
    if (Number.isFinite(minSz) && minSz > 0 && contracts < minSz) contracts = minSz;
    return contracts.toFixed(this.lotDecimals(info));
  }

  async pricePrecision(symbol: string): Promise<number | null> {
    const info = await this.infoFor(symbol);
    return info?.tickSz != null ? decimalsOf(info.tickSz) : null;
  }

  /** Limits converted from contracts back into BASE-ASSET units. */
  async orderFilters(symbol: string): Promise<OrderFilters> {
    const info = await this.infoFor(symbol);
    if (!info) {
      return {
        baseDecimals: null, quoteDecimals: null,
        minSizeLimit: null, minSizeMarket: null, minNotional: null,
      };
    }
    const ctVal = Number(info.ctVal);
    const lotSz = Number(info.lotSz);
    const minSz = Number(info.minSz);
    const baseStep =
      Number.isFinite(ctVal) && Number.isFinite(lotSz) ? ctVal * lotSz : null;
    const minBase =
      Number.isFinite(ctVal) && Number.isFinite(minSz) ? ctVal * minSz : null;
    return {
      baseDecimals: baseStep != null ? stepDecimals(baseStep) : null,
      quoteDecimals: info.tickSz != null ? decimalsOf(info.tickSz) : null,
      minSizeLimit: minBase,
      minSizeMarket: minBase,
      minNotional: null,
    };
  }

  // --------------------------------------------------------- market data
  async getPrice(instId: string): Promise<number> {
    const rows = await this.request("GET", "/api/v5/market/ticker", { instId });
    const px = parseFloat(rows[0]?.last);
    if (!Number.isFinite(px)) throw new OkxApiError(`no ticker for ${instId}`);
    return px;
  }

  /** High/low since `sinceMs`, from 1-minute candles.
   *  OKX candle rows are arrays: [ts, o, h, l, c, ...]. */
  async priceRange(
    instId: string,
    sinceMs: number
  ): Promise<{ high: number; low: number } | null> {
    let rows: any[];
    try {
      rows = await this.request("GET", "/api/v5/market/candles", {
        instId, bar: "1m", limit: "60",
      });
    } catch {
      return null;
    }
    let high = -Infinity;
    let low = Infinity;
    let n = 0;
    for (const k of rows) {
      const t = Number(k?.[0]);
      if (Number.isFinite(t) && t + 60_000 < sinceMs) continue;
      const h = parseFloat(k?.[2]);
      const l = parseFloat(k?.[3]);
      if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
      high = Math.max(high, h);
      low = Math.min(low, l);
      n++;
    }
    return n ? { high, low } : null;
  }

  // -------------------------------------------------------- account/trade
  async getAvailableUsdt(): Promise<number> {
    const rows = await this.request("GET", "/api/v5/account/balance", { ccy: "USDT" });
    const details: any[] = rows[0]?.details ?? [];
    const usdt = details.find((d) => d.ccy === "USDT");
    const v = parseFloat(usdt?.availBal ?? usdt?.availEq ?? "0");
    return Number.isFinite(v) ? v : 0;
  }

  /** Open swap positions, converted from contracts back to base units. */
  async fetchPositions(): Promise<
    { symbol: string; side: "long" | "short"; qty: number; entryPrice: number }[]
  > {
    const rows = await this.request("GET", "/api/v5/account/positions", {
      instType: "SWAP",
    });
    const out: { symbol: string; side: "long" | "short"; qty: number; entryPrice: number }[] = [];
    for (const r of rows) {
      const contracts = Number(r?.pos);
      if (!Number.isFinite(contracts) || contracts === 0) continue;
      const info = await this.infoFor(String(r.instId));
      const ctVal = Number(info?.ctVal);
      if (!Number.isFinite(ctVal) || ctVal <= 0) continue;
      // hedge mode names the side; in net mode the sign of `pos` carries it
      const side: "long" | "short" =
        r.posSide === "long" || r.posSide === "short"
          ? r.posSide
          : contracts > 0
          ? "long"
          : "short";
      out.push({
        symbol: String(r.instId),
        side,
        qty: Math.abs(contracts) * ctVal,
        entryPrice: Number(r.avgPx) || 0,
      });
    }
    return out;
  }

  async setLeverage(instId: string, leverage: number): Promise<void> {
    await this.request("POST", "/api/v5/account/set-leverage", {}, {
      instId, lever: String(leverage), mgnMode: this.tdMode,
    });
  }

  async getOpenOrders(instId: string): Promise<any[]> {
    const rows = await this.request("GET", "/api/v5/trade/orders-pending", {
      instType: "SWAP", instId,
    });
    // normalize to the orderId field the executor looks for
    return rows.map((o: any) => ({ ...o, orderId: o.ordId }));
  }

  async placeOrder(opts: PlaceOrderOpts): Promise<PlacedOrder> {
    const info = await this.infoFor(opts.symbol);
    if (!info) throw new OkxApiError(`OKX 找不到合約 ${opts.symbol}`);
    const body: Record<string, unknown> = {
      instId: opts.symbol,
      tdMode: this.tdMode,
      side: opts.side.toLowerCase(),          // buy | sell
      ordType: opts.type.toLowerCase(),       // market | limit
      sz: this.szFromBase(info, Number(opts.size ?? 0)),
    };
    if (opts.type === "LIMIT" && opts.price !== undefined) body.px = opts.price;

    // Attach the protective levels to the order itself, so a filled position is
    // never momentarily unprotected and stays protected even if nothing else
    // runs afterwards. TP and SL must be SEPARATE entries - combining them in
    // one attachment is rejected with 51076.
    if (opts.attach) {
      const dec = decimalsOf(info.tickSz) ?? 8;
      const attach: Record<string, string>[] = [];
      if (opts.attach.stopLoss != null && opts.attach.stopLoss > 0) {
        attach.push({
          slTriggerPx: opts.attach.stopLoss.toFixed(dec),
          slOrdPx: "-1",                      // close at market on trigger
        });
      }
      if (opts.attach.takeProfit != null && opts.attach.takeProfit > 0) {
        attach.push({
          tpTriggerPx: opts.attach.takeProfit.toFixed(dec),
          tpOrdPx: "-1",
        });
      }
      if (attach.length) body.attachAlgoOrds = attach;
    }

    if ((await this.posMode()) === "long_short_mode") {
      // 雙向持倉: every order must name the position it acts on. Closing is
      // the OPPOSITE side of the position being reduced (sell closes a long).
      // reduceOnly is a net-mode-only flag, so it is omitted here - posSide
      // plus the opposing side already means "reduce that position".
      body.posSide = opts.reduceOnly
        ? (opts.side === "SELL" ? "long" : "short")
        : (opts.side === "BUY" ? "long" : "short");
    } else if (opts.reduceOnly) {
      body.reduceOnly = true;
    }
    if (opts.clientOrderId) body.clOrdId = opts.clientOrderId;

    let rows: any[];
    try {
      rows = await this.request("POST", "/api/v5/trade/order", {}, body);
    } catch (e) {
      // Distinguish "the attached TP/SL was invalid" from "the order was
      // invalid": the former can be retried bare so the trade still happens.
      const msg = (e as Error).message;
      if (body.attachAlgoOrds && /\b(51076|51277|51278|51279|51280)\b|attachAlgo/i.test(msg)) {
        throw new AttachRejectedError(msg);
      }
      throw e;
    }
    const first = rows[0] ?? {};
    // a per-order failure can still arrive under a top-level code of "0"
    if (first.sCode !== undefined && String(first.sCode) !== "0") {
      const msg = `OKX API error (${first.sCode}): ${first.sMsg ?? ""}`;
      if (body.attachAlgoOrds && /\b(51076|51277|51278|51279|51280)\b|attachAlgo/i.test(msg)) {
        throw new AttachRejectedError(msg);
      }
      throw new OkxApiError(msg, String(first.sCode), first);
    }
    return { orderId: first.ordId ? String(first.ordId) : null, raw: first };
  }

  async describeOrderSize(symbol: string, baseQty: number): Promise<string | null> {
    const info = await this.infoFor(symbol);
    if (!info) return null;
    const ctVal = Number(info.ctVal);
    if (!Number.isFinite(ctVal) || ctVal <= 0) return null;
    const base = String(info.instId).split("-")[0];
    return `${this.szFromBase(info, baseQty)} 張（每張 ${info.ctVal} ${base}）`;
  }

  /**
   * Rest a protective TP/SL on the exchange as an algo order, so the position
   * is closed by OKX itself even if this app is down. `ordType: "oco"` carries
   * both legs and cancels the other when one triggers; with only one level set
   * a plain "conditional" order is used. An order price of -1 means "close at
   * market when triggered", which is what a protective stop wants.
   */
  async placeStopOrders(opts: {
    symbol: string;
    side: "BUY" | "SELL";
    size: string;
    stopLoss?: number | null;
    takeProfits?: { price: number; size: string }[];
  }): Promise<string[]> {
    const hasSl = opts.stopLoss != null && opts.stopLoss > 0;
    const tps = (opts.takeProfits ?? []).filter((t) => t.price > 0);
    if (!hasSl && !tps.length) return [];
    const info = await this.infoFor(opts.symbol);
    if (!info) throw new OkxApiError(`OKX 找不到合約 ${opts.symbol}`);

    const dec = decimalsOf(info.tickSz) ?? 8;
    const lotDec = this.lotDecimals(info);
    const minSz = Number(info.minSz) || 0;
    const hedge = (await this.posMode()) === "long_short_mode";
    // these orders only ever REDUCE the position
    const scope: Record<string, unknown> = hedge
      ? { posSide: opts.side === "SELL" ? "long" : "short" }
      : { reduceOnly: true };
    const base = {
      instId: opts.symbol,
      tdMode: this.tdMode,
      side: opts.side.toLowerCase(),
      ...scope,
    };

    const send = async (body: Record<string, unknown>): Promise<string | null> => {
      const rows = await this.request("POST", "/api/v5/trade/order-algo", {}, body);
      const first = rows[0] ?? {};
      if (first.sCode !== undefined && String(first.sCode) !== "0") {
        throw new OkxApiError(`OKX API error (${first.sCode}): ${first.sMsg ?? ""}`, String(first.sCode), first);
      }
      return first.algoId ? String(first.algoId) : null;
    };

    // Single target + stop: one OCO, where triggering either cancels the other.
    if (hasSl && tps.length === 1) {
      const id = await send({
        ...base,
        ordType: "oco",
        sz: this.szFromBase(info, Number(opts.size ?? 0)),
        slTriggerPx: opts.stopLoss!.toFixed(dec),
        slOrdPx: "-1",                  // close at market on trigger
        tpTriggerPx: tps[0].price.toFixed(dec),
        tpOrdPx: "-1",
      });
      return id ? [id] : [];
    }

    // 分批止盈: OCO can only pair ONE target with the stop, so split targets get
    // their own conditional orders and the stop covers the whole remainder
    // (it is reduce-only, so it can never close more than is actually open).
    const ids: string[] = [];
    if (hasSl) {
      const id = await send({
        ...base,
        ordType: "conditional",
        sz: this.szFromBase(info, Number(opts.size ?? 0)),
        slTriggerPx: opts.stopLoss!.toFixed(dec),
        slOrdPx: "-1",
      });
      if (id) ids.push(id);
    }
    for (const tp of tps) {
      // a slice below the venue minimum cannot be placed; skip it rather than
      // rounding up, which would close more of the position than intended -
      // the monitor still takes that target.
      const contracts = this.contractsFor(info, Number(tp.size));
      if (contracts <= 0 || (minSz > 0 && contracts < minSz)) continue;
      const id = await send({
        ...base,
        ordType: "conditional",
        sz: contracts.toFixed(lotDec),
        tpTriggerPx: tp.price.toFixed(dec),
        tpOrdPx: "-1",
      });
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Pending algo (TP/SL) orders for a symbol. */
  /** Pending algo (TP/SL) orders for a symbol.
   *
   *  Failures are NOT swallowed. Returning [] on a failed lookup makes "the
   *  query broke" indistinguishable from "this position has no protection",
   *  which makes the monitor place a fresh set every tick while the cancel step
   *  removes nothing - orders pile up with no signal involved. */
  private async getAlgoOrders(instId: string): Promise<any[]> {
    const out: any[] = [];
    for (const ordType of ["oco", "conditional"]) {
      const rows = await this.request("GET", "/api/v5/trade/orders-algo-pending", {
        instId, ordType,
      });
      out.push(...rows);
    }
    return out;
  }

  /** Every pending algo order on the account, for orphan cleanup. */
  async fetchAllStopOrders(): Promise<{ symbol: string; algoId: string }[]> {
    const out: { symbol: string; algoId: string }[] = [];
    for (const ordType of ["oco", "conditional"]) {
      const rows = await this.request("GET", "/api/v5/trade/orders-algo-pending", { ordType });
      for (const r of rows) {
        if (r?.algoId && r?.instId) out.push({ symbol: String(r.instId), algoId: String(r.algoId) });
      }
    }
    return out;
  }

  async countStopOrders(instId: string): Promise<number> {
    return (await this.getAlgoOrders(instId)).length;
  }

  /** Cancels the symbol's protective orders. Throws if they cannot be
   *  enumerated or cancelled, so callers never place replacements on top of
   *  orders that are still live. */
  async cancelStopOrders(instId: string): Promise<number> {
    const orders = await this.getAlgoOrders(instId);
    const ids = orders
      .map((o: any) => String(o.algoId ?? ""))
      .filter(Boolean)
      .map((algoId) => ({ algoId, instId }));
    if (!ids.length) return 0;
    await this.request("POST", "/api/v5/trade/cancel-algos", {}, ids);
    return ids.length;
  }

  async cancelStopOrderIds(items: { symbol: string; algoId: string }[]): Promise<number> {
    if (!items.length) return 0;
    await this.request("POST", "/api/v5/trade/cancel-algos", {},
      items.map((i) => ({ algoId: i.algoId, instId: i.symbol })));
    return items.length;
  }

  async cancelOrder(instId: string, orderId: string): Promise<unknown> {
    return this.request("POST", "/api/v5/trade/cancel-order", {}, {
      instId, ordId: orderId,
    });
  }

  async cancelAllOrders(instId: string): Promise<number> {
    const orders = await this.getOpenOrders(instId).catch(() => []);
    let n = 0;
    for (const o of orders) {
      const id = String(o.ordId ?? o.orderId ?? "");
      if (!id) continue;
      await this.cancelOrder(instId, id).catch(() => {});
      n++;
    }
    return n;
  }
}
