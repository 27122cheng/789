import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ceilToDecimals,
  decimalsOf,
  floorToDecimals,
  signRequest,
  toPerpSymbol,
} from "../pionex";

describe("request signing", () => {
  it("signs METHOD + path + sorted query", () => {
    const sig = signRequest("secret", "GET", "/api/v1/account/balances", {
      timestamp: "1700000000000",
    });
    const expected = createHmac("sha256", "secret")
      .update("GET/api/v1/account/balances?timestamp=1700000000000")
      .digest("hex");
    expect(sig).toBe(expected);
  });

  it("sorts query params by key", () => {
    const sig = signRequest("secret", "GET", "/p", {
      timestamp: "2",
      symbol: "BTC_USDT_PERP",
    });
    const expected = createHmac("sha256", "secret")
      .update("GET/p?symbol=BTC_USDT_PERP&timestamp=2")
      .digest("hex");
    expect(sig).toBe(expected);
  });

  it("appends the exact JSON body for POST", () => {
    const body = JSON.stringify({ symbol: "BTC_USDT_PERP", side: "BUY" });
    const sig = signRequest("secret", "POST", "/api/v1/trade/order",
      { timestamp: "5" }, body);
    const expected = createHmac("sha256", "secret")
      .update("POST/api/v1/trade/order?timestamp=5" + body)
      .digest("hex");
    expect(sig).toBe(expected);
  });
});

describe("toPerpSymbol", () => {
  it("converts normalized symbols with the default (Pionex perp trade) format", () => {
    // Pionex perp trade symbol = base_quote (no _PERP), market via type=PERP
    expect(toPerpSymbol("BTCUSDT")).toBe("BTC_USDT");
    expect(toPerpSymbol("eth-usdt")).toBe("ETH_USDT");
    expect(toPerpSymbol("SOL/USDC")).toBe("SOL_USDC");
    expect(toPerpSymbol("DOGE")).toBe("DOGE_USDT");
  });

  it("honours a configurable format", () => {
    expect(toPerpSymbol("BTCUSDT", "{base}_{quote}_PERP")).toBe("BTC_USDT_PERP");
    expect(toPerpSymbol("BTCUSDT", "{base}{quote}")).toBe("BTCUSDT");
    expect(toPerpSymbol("SOLUSDT", "{base}-{quote}-SWAP")).toBe("SOL-USDT-SWAP");
  });
});

describe("price precision rounding", () => {
  it("decimalsOf reads tick strings", () => {
    expect(decimalsOf("0.001")).toBe(3);
    expect(decimalsOf("0.00001")).toBe(5);
    expect(decimalsOf("1")).toBe(0);
    expect(decimalsOf("abc")).toBeNull();
  });

  it("entry/SL round UP (無條件進位)", () => {
    expect(ceilToDecimals(0.00117914, 5)).toBe(0.00118);
    expect(ceilToDecimals(0.4633, 3)).toBe(0.464);
    expect(ceilToDecimals(60000, 1)).toBe(60000); // already aligned
  });

  it("TP rounds DOWN (無條件縮減)", () => {
    expect(floorToDecimals(0.00096014, 5)).toBe(0.00096);
    expect(floorToDecimals(0.444359, 3)).toBe(0.444);
    expect(floorToDecimals(61000, 2)).toBe(61000);
  });
});
