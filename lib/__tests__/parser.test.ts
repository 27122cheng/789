import { describe, expect, it } from "vitest";
import { dedupKey, isFiltered, parseSignal } from "../parser";
import { DEFAULT_SETTINGS } from "../types";

const meta = { chatId: "-100123", messageId: 1, timestamp: Date.now() };

describe("open signals", () => {
  it("parses the standard english format", () => {
    const s = parseSignal(
      "BTCUSDT LONG 10x\nEntry: 60000-60500\nTP1: 61000\nTP2: 62500\nSL: 59000",
      meta
    )!;
    expect(s.action).toBe("open");
    expect(s.symbol).toBe("BTCUSDT");
    expect(s.side).toBe("long");
    expect(s.leverage).toBe(10);
    expect(s.entryPrice).toBe(60000);
    expect(s.entryPriceHigh).toBe(60500);
    expect(s.takeProfits).toEqual([61000, 62500]);
    expect(s.stopLoss).toBe(59000);
  });

  it("parses chinese full-width format", () => {
    const s = parseSignal(
      "幣種：ETHUSDT\n方向：做空\n槓桿：20倍\n入場價：3200\n止盈：3300，3400\n止損：3100",
      meta
    )!;
    expect(s.symbol).toBe("ETHUSDT");
    expect(s.side).toBe("short");
    expect(s.leverage).toBe(20);
    expect(s.entryPrice).toBe(3200);
    expect(s.takeProfits).toEqual([3300, 3400]);
    expect(s.stopLoss).toBe(3100);
  });

  it("handles thousands separators", () => {
    const s = parseSignal("BTCUSDT LONG entry 60,000 sl 59,500", meta)!;
    expect(s.entryPrice).toBe(60000);
    expect(s.stopLoss).toBe(59500);
  });

  it("flags a structural open without side but warns", () => {
    // entry + SL present -> clearly an open, even though side is missing
    const s = parseSignal("BTCUSDT entry 60000 SL 59000", meta)!;
    expect(s.action).toBe("open");
    expect(s.side).toBeNull();
    expect(s.warnings.length).toBeGreaterThan(0);
  });

  it("treats a bare symbol+price with no structure as NOT a signal", () => {
    // no side, no SL/TP, no action keyword -> analysis/chatter, not tradable
    expect(parseSignal("BTCUSDT 60000 附近觀望", meta)).toBeNull();
    expect(parseSignal("BTCUSDT 目前 60000", meta)).toBeNull();
  });

  it("extracts explicit USDT size", () => {
    const s = parseSignal("BTCUSDT long 10x 金額: 250 USDT sl 59000", meta)!;
    expect(s.sizeUsdt).toBe(250);
  });
});

describe("action classification", () => {
  it("close", () => {
    expect(parseSignal("BTCUSDT 平倉", meta)!.action).toBe("close");
    expect(parseSignal("close BTCUSDT now", meta)!.action).toBe("close");
  });

  it("add position 加倉", () => {
    const s = parseSignal("BTCUSDT 加倉", meta)!;
    expect(s.action).toBe("add");
    const s2 = parseSignal("ETHUSDT add position 50 USDT", meta)!;
    expect(s2.action).toBe("add");
    expect(s2.sizeUsdt).toBe(50);
  });

  it("cancel orders 取消掛單", () => {
    expect(parseSignal("取消 BTCUSDT 掛單", meta)!.action).toBe("cancel");
    expect(parseSignal("cancel BTCUSDT orders", meta)!.action).toBe("cancel");
    expect(parseSignal("BTCUSDT 撤單", meta)!.action).toBe("cancel");
  });

  it("update stop loss with value", () => {
    const s = parseSignal("BTCUSDT 止損移至 60000", meta)!;
    expect(s.action).toBe("update_sl");
    expect(s.stopLoss).toBe(60000);
    const s2 = parseSignal("BTCUSDT move SL to 61000", meta)!;
    expect(s2.action).toBe("update_sl");
    expect(s2.stopLoss).toBe(61000);
  });

  it("update stop loss to breakeven", () => {
    const s = parseSignal("BTCUSDT 止損移至保本", meta)!;
    expect(s.action).toBe("update_sl");
    expect(s.stopLossBreakeven).toBe(true);
    expect(s.stopLoss).toBeNull();
  });

  it("update take profit", () => {
    const s = parseSignal("BTCUSDT 止盈改為 62000, 63000", meta)!;
    expect(s.action).toBe("update_tp");
    expect(s.takeProfits).toEqual([62000, 63000]);
  });

  it("an open signal with SL is NOT misread as update_sl", () => {
    const s = parseSignal("BTCUSDT LONG 10x entry 60000 SL: 59000", meta)!;
    expect(s.action).toBe("open");
  });
});

describe("filtering", () => {
  it("returns null for chatter without a pair", () => {
    expect(parseSignal("gm everyone, market looking spicy", meta)).toBeNull();
    expect(parseSignal("", meta)).toBeNull();
  });

  it("filters news / data-release messages via keywords", () => {
    const kws = DEFAULT_SETTINGS.filters.ignoreKeywords;
    expect(isFiltered("今晚 CPI 數據公布，注意行情波動", kws)).toBe(true);
    expect(isFiltered("非农数据即将公布 BTCUSDT 可能剧烈波动", kws)).toBe(true);
    expect(isFiltered("BTCUSDT LONG 10x entry 60000", kws)).toBe(false);
  });
});

describe("dedup", () => {
  it("same message id but edited text gets a new key", () => {
    const a = parseSignal("BTCUSDT long sl 59000", meta)!;
    const b = parseSignal("BTCUSDT long sl 58000", meta)!;
    expect(dedupKey(a)).not.toBe(dedupKey(b));
    const a2 = parseSignal("BTCUSDT long sl 59000", meta)!;
    expect(dedupKey(a)).toBe(dedupKey(a2));
  });
});
