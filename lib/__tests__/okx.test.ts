import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OkxClient, okxSign, toOkxInstId } from "../okx";

afterEach(() => vi.unstubAllGlobals());

/** Stubs OKX with one instrument: 1 contract = 0.01 BTC, lot step 0.1. */
function stubOkx(captured: any[], extra: Record<string, any> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    let data: any[] = [];
    if (url.includes("/account/config")) {
      data = [{ posMode: extra.posMode ?? "net_mode" }];
    } else if (url.includes("/public/instruments")) {
      data = [{
        instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.1",
        minSz: "0.1", tickSz: "0.1",
      }];
    } else if (url.includes("/market/ticker")) {
      data = [{ last: "60000" }];
    } else if (url.includes("/market/candles")) {
      data = extra.candles ?? [[String(Date.now()), "1", "61000", "59000", "2"]];
    } else if (url.includes("/trade/order")) {
      captured.push({ url, body, headers: init?.headers });
      data = [{ ordId: "OID-9", sCode: extra.sCode ?? "0", sMsg: extra.sMsg ?? "" }];
    }
    return { ok: true, status: 200, json: async () => ({ code: "0", msg: "", data }) };
  }));
}

describe("okx symbol + signing", () => {
  it("maps normalized symbols to swap instrument ids", () => {
    expect(toOkxInstId("BTCUSDT")).toBe("BTC-USDT-SWAP");
    expect(toOkxInstId("eth-usdt")).toBe("ETH-USDT-SWAP");
    expect(toOkxInstId("DOGE")).toBe("DOGE-USDT-SWAP");
  });

  it("signs base64(HMAC(timestamp+METHOD+path+body))", () => {
    const sig = okxSign("secret", "2020-12-08T09:08:57.715Z", "GET", "/api/v5/account/balance?ccy=BTC", "");
    const expected = createHmac("sha256", "secret")
      .update("2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC")
      .digest("base64");
    expect(sig).toBe(expected);
  });
});

describe("okx contract sizing", () => {
  it("converts a base quantity into CONTRACTS using ctVal", async () => {
    const captured: any[] = [];
    stubOkx(captured);
    const c = new OkxClient("k", "s", "p");
    // 0.5 BTC / 0.01 BTC-per-contract = 50 contracts
    await c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "BUY", type: "MARKET", size: "0.5" });
    expect(captured[0].body.sz).toBe("50.0");
    expect(captured[0].body.instId).toBe("BTC-USDT-SWAP");
    expect(captured[0].body.tdMode).toBe("cross");
    expect(captured[0].body.side).toBe("buy");
    expect(captured[0].body.ordType).toBe("market");
  });

  it("snaps contracts down to the lot step and lifts to the minimum", async () => {
    const captured: any[] = [];
    stubOkx(captured);
    const c = new OkxClient("k", "s", "p");
    // 0.00123 BTC -> 0.123 contracts -> floor to 0.1 step
    await c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "SELL", type: "MARKET", size: "0.00123" });
    expect(captured[0].body.sz).toBe("0.1");
  });

  it("reports limits back in base-asset units", async () => {
    stubOkx([]);
    const c = new OkxClient("k", "s", "p");
    const f = await c.orderFilters("BTCUSDT");
    // step = ctVal*lotSz = 0.001 BTC -> 3 dp; min = ctVal*minSz = 0.001 BTC
    expect(f.baseDecimals).toBe(3);
    expect(f.minSizeLimit).toBeCloseTo(0.001, 10);
    expect(f.quoteDecimals).toBe(1);
  });

  it("sends limit price and reduceOnly through", async () => {
    const captured: any[] = [];
    stubOkx(captured);
    const c = new OkxClient("k", "s", "p");
    await c.placeOrder({
      symbol: "BTC-USDT-SWAP", side: "SELL", type: "LIMIT",
      size: "0.5", price: "61000.0", reduceOnly: true,
    });
    expect(captured[0].body.ordType).toBe("limit");
    expect(captured[0].body.px).toBe("61000.0");
    expect(captured[0].body.reduceOnly).toBe(true);
  });

  it("throws on a per-order failure even when the envelope says code 0", async () => {
    stubOkx([], { sCode: "51008", sMsg: "insufficient balance" });
    const c = new OkxClient("k", "s", "p");
    await expect(
      c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "BUY", type: "MARKET", size: "0.5" })
    ).rejects.toThrow(/51008/);
  });
});

describe("okx position mode", () => {
  it("net mode: no posSide, reduceOnly kept", async () => {
    const captured: any[] = [];
    stubOkx(captured, { posMode: "net_mode" });
    const c = new OkxClient("k", "s", "p");
    await c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "SELL", type: "MARKET", size: "0.5", reduceOnly: true });
    expect(captured[0].body.posSide).toBeUndefined();
    expect(captured[0].body.reduceOnly).toBe(true);
  });

  it("hedge mode: opening names the position side it creates", async () => {
    const captured: any[] = [];
    stubOkx(captured, { posMode: "long_short_mode" });
    const c = new OkxClient("k", "s", "p");
    await c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "BUY", type: "MARKET", size: "0.5" });
    expect(captured[0].body.posSide).toBe("long");
    await c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "SELL", type: "MARKET", size: "0.5" });
    expect(captured[1].body.posSide).toBe("short");
  });

  it("hedge mode: closing names the position being reduced, not the order side", async () => {
    const captured: any[] = [];
    stubOkx(captured, { posMode: "long_short_mode" });
    const c = new OkxClient("k", "s", "p");
    // selling to close a LONG must target posSide=long
    await c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "SELL", type: "MARKET", size: "0.5", reduceOnly: true });
    expect(captured[0].body.posSide).toBe("long");
    // buying to close a SHORT must target posSide=short
    await c.placeOrder({ symbol: "BTC-USDT-SWAP", side: "BUY", type: "MARKET", size: "0.5", reduceOnly: true });
    expect(captured[1].body.posSide).toBe("short");
    // reduceOnly is a net-mode-only flag; posSide already scopes the close
    expect(captured[0].body.reduceOnly).toBeUndefined();
  });
});

describe("okx market data", () => {
  it("reads the last price", async () => {
    stubOkx([]);
    const c = new OkxClient("k", "s", "p");
    expect(await c.getPrice("BTC-USDT-SWAP")).toBe(60000);
  });

  it("reads high/low from candle arrays", async () => {
    stubOkx([]);
    const c = new OkxClient("k", "s", "p");
    const r = await c.priceRange("BTC-USDT-SWAP", Date.now() - 60_000);
    expect(r).toEqual({ high: 61000, low: 59000 });
  });
});
