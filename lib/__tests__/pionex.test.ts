import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signRequest, toPerpSymbol } from "../pionex";

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
  it("converts normalized symbols", () => {
    expect(toPerpSymbol("BTCUSDT")).toBe("BTC_USDT_PERP");
    expect(toPerpSymbol("eth-usdt")).toBe("ETH_USDT_PERP");
    expect(toPerpSymbol("SOL/USDC")).toBe("SOL_USDC_PERP");
    expect(toPerpSymbol("DOGE")).toBe("DOGE_USDT_PERP");
  });
});
