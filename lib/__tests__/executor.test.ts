/**
 * End-to-end pipeline test in dry-run mode using the in-memory store.
 * global.fetch is stubbed so no real network is touched; price lookups fail
 * and fall back to the signal's entry price, and the monitor is fed a fake
 * ticker response where needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIncomingMessage, monitorTick } from "../executor";
import { getOrders, getPositions, getSignals } from "../store";
import { DEFAULT_SETTINGS, Settings } from "../types";

function settings(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS) as Settings;
  s.telegram.allowedChats = ["-100123"];
  s.trading.liveTrading = false;
  return s;
}

let msgId = 0;
function meta() {
  msgId += 1;
  return { chatId: "-100123", messageId: msgId, timestamp: Date.now() };
}

function stubFetchFailing() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
}

function stubFetchPrice(price: number) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      result: true,
      data: { tickers: [{ close: String(price) }] },
    }),
  })));
}

beforeEach(() => stubFetchFailing());
afterEach(() => vi.unstubAllGlobals());

describe("dry-run pipeline", () => {
  it("open -> add -> move SL to breakeven -> TP/SL monitoring", async () => {
    const cfg = settings();

    // 1. open long from a signal (price lookup fails -> entry price used)
    await handleIncomingMessage(
      "BTCUSDT LONG 10x\nEntry: 60000\nTP1: 61000\nTP2: 62000\nSL: 59000",
      meta(), cfg
    );
    let positions = await getPositions();
    let pos = positions["BTCUSDT"];
    expect(pos).toBeDefined();
    expect(pos.side).toBe("long");
    expect(pos.entryPrice).toBe(60000);
    expect(pos.stopLoss).toBe(59000);
    expect(pos.takeProfits).toEqual([61000, 62000]);
    expect(pos.dryRun).toBe(true);

    // duplicate of the same open is rejected (position already open)
    await handleIncomingMessage("BTCUSDT LONG 10x Entry: 60000", meta(), cfg);
    positions = await getPositions();
    expect(Object.keys(positions)).toEqual(["BTCUSDT"]);

    // 2. 加倉 (cooldown must pass -> zero it for the test)
    cfg.trading.risk.cooldownSeconds = 0;
    const qtyBefore = positions["BTCUSDT"].qty;
    await handleIncomingMessage("BTCUSDT 加倉", meta(), cfg);
    positions = await getPositions();
    pos = positions["BTCUSDT"];
    expect(pos.addCount).toBe(1);
    expect(pos.qty).toBeGreaterThan(qtyBefore);

    // 3. move stop loss to breakeven
    await handleIncomingMessage("BTCUSDT 止損移至保本", meta(), cfg);
    positions = await getPositions();
    expect(positions["BTCUSDT"].stopLoss).toBe(positions["BTCUSDT"].entryPrice);

    // 4. price reaches TP1 -> partial close
    stubFetchPrice(61500);
    let actions = await monitorTick(cfg);
    expect(actions.some((a) => a.includes("TP 61000 hit"))).toBe(true);
    positions = await getPositions();
    expect(positions["BTCUSDT"].takeProfits).toEqual([62000]);
    expect(positions["BTCUSDT"].qty).toBeLessThan(pos.qty);

    // 5. price falls to the (breakeven) stop -> full close
    stubFetchPrice(59900);
    actions = await monitorTick(cfg);
    expect(actions.some((a) => a.includes("SL hit"))).toBe(true);
    positions = await getPositions();
    expect(positions["BTCUSDT"]).toBeUndefined();

    const orders = await getOrders();
    const kinds = orders.map((o) => o.action);
    expect(kinds).toContain("open");
    expect(kinds).toContain("add");
    expect(kinds).toContain("update_sl");
    expect(kinds).toContain("tp_hit");
    expect(kinds).toContain("sl_hit");
    expect(orders.every((o) => o.dryRun)).toBe(true);
  });

  it("trailing stop ratchets the SL upward for a long", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.trailing = {
      enabled: true, activateProfitPercent: 1, callbackPercent: 1,
    };

    await handleIncomingMessage(
      "ETHUSDT LONG 5x Entry: 3000 SL: 2900", meta(), cfg
    );

    stubFetchPrice(3100); // +3.33% -> trailing active, SL -> 3100*0.99=3069
    await monitorTick(cfg);
    let positions = await getPositions();
    expect(positions["ETHUSDT"].stopLoss).toBeCloseTo(3069, 0);

    stubFetchPrice(3070); // lower price (but above SL) must NOT lower the SL
    await monitorTick(cfg);
    positions = await getPositions();
    expect(positions["ETHUSDT"].stopLoss).toBeCloseTo(3069, 0);

    stubFetchPrice(3060); // price crosses the trailed SL -> position closes
    const actions = await monitorTick(cfg);
    expect(actions.some((a) => a.includes("SL hit"))).toBe(true);
    positions = await getPositions();
    expect(positions["ETHUSDT"]).toBeUndefined();
  });

  it("filters news messages and records them", async () => {
    const cfg = settings();
    await handleIncomingMessage(
      "今晚 CPI 數據公布，BTCUSDT 可能劇烈波動", meta(), cfg
    );
    const signals = await getSignals();
    expect(signals[0].action).toBe("filtered");
    const positions = await getPositions();
    expect(positions["BTCUSDT"]).toBeUndefined();
  });

  it("cancel clears tracked pending orders", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    await handleIncomingMessage("SOLUSDT LONG 5x Entry: 150 SL: 140", meta(), cfg);
    await handleIncomingMessage("取消 SOLUSDT 掛單", meta(), cfg);
    const orders = await getOrders();
    expect(orders[0].action).toBe("cancel");
    expect(orders[0].success).toBe(true);
  });
});

describe("加密掃描 Pro pipeline behaviours", () => {
  const LONG_TERM = `🔼 加密掃描 Pro — 長線單升級信號
▼ 做空（Short）：ONE/USDT
📍 進場： $0.00117914
🛑 止損： $0.00120651 (+2.32%)
🏁 最終止盈： $0.00096014 (-18.57% | R:R 8.0:1)
💰 加倉計劃（2 次）
 🥇 加倉 1： $0.00110614
 🥈 加倉 2： $0.00103314`;

  it("executes planned add levels when price reaches them", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    await handleIncomingMessage(LONG_TERM, meta(), cfg);
    let positions = await getPositions();
    let pos = positions["ONEUSDT"];
    expect(pos).toBeDefined();
    expect(pos.side).toBe("short");
    expect(pos.pendingAdds).toEqual([0.00110614, 0.00103314]);

    // price falls to the first add level -> planned add executes
    stubFetchPrice(0.0011);
    await monitorTick(cfg);
    positions = await getPositions();
    pos = positions["ONEUSDT"];
    expect(pos.addCount).toBe(1);
    expect(pos.pendingAdds).toEqual([0.00103314]);

    // falls through the second level too
    stubFetchPrice(0.00103);
    await monitorTick(cfg);
    positions = await getPositions();
    pos = positions["ONEUSDT"];
    expect(pos.addCount).toBe(2);
    expect(pos.pendingAdds).toEqual([]);
  });

  it("moves SL near entry after TP1 is hit", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    await handleIncomingMessage(
      `▲ 做多（Long）：ZEC/USDT
📍 進場： $533
🛑 止損： $526.133 (-1.29%)
🎯 止盈一： $543.301 (+1.93% | R:R 1.5:1)
🚀 止盈二： $553.601 (+3.87% | R:R 3.0:1)`,
      meta(), cfg
    );
    stubFetchPrice(544); // TP1 hit
    await monitorTick(cfg);
    const positions = await getPositions();
    const pos = positions["ZECUSDT"];
    expect(pos).toBeDefined();
    expect(pos.takeProfits).toEqual([553.601]);
    // SL moved to entry * (1 - 0.2%) = 531.934
    expect(pos.stopLoss).toBeCloseTo(533 * 0.998, 3);
    expect(pos.beMoved).toBe(true);
  });

  it("applies a bot 建議止損調整 message to the tracked position", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    await handleIncomingMessage(
      `▼ 做空（Short）：XTZ/USDT
📍 進場： $0.2394
🛑 止損： $0.2450
🏁 最終止盈： $0.2000`,
      meta(), cfg
    );
    await handleIncomingMessage(
      `🚀 AI 偵測：盈利 3.2R，建議追蹤止損
💎 XTZ/USDT ▼ 空
🛑 建議止損調整
 新止損： $0.237906`,
      meta(), cfg
    );
    const positions = await getPositions();
    expect(positions["XTZUSDT"].stopLoss).toBe(0.237906);
  });

  it("rejects an open signal without entry/SL when requireEntryAndSl is on", async () => {
    const cfg = settings();
    await handleIncomingMessage("APTUSDT 做多 看起來不錯", meta(), cfg);
    const positions = await getPositions();
    expect(positions["APTUSDT"]).toBeUndefined();
  });

  it("交易建議已取消 closes the tracked market position", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    await handleIncomingMessage(
      `▲ 做多（Long）：ACH/USDT
📍 進場： $0.02
🛑 止損： $0.019
🎯 止盈一： $0.022`,
      meta(), cfg
    );
    expect((await getPositions())["ACHUSDT"]).toBeDefined();
    await handleIncomingMessage(
      `🚫 交易建議已取消
▲ 做多（Long）：ACH/USDT
📋 取消原因：訊號品質下降`,
      meta(), cfg
    );
    expect((await getPositions())["ACHUSDT"]).toBeUndefined();
  });
});
