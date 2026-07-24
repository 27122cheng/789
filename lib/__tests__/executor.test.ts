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

  it("splitTakeProfit=false closes the whole position at the first TP", async () => {
    const cfg = settings();
    cfg.trading.orders.splitTakeProfit = false;
    await handleIncomingMessage(
      "BTCUSDT LONG Entry: 60000 TP1: 61000 TP2: 62000 SL: 59000", meta(), cfg
    );
    stubFetchPrice(61000); // first TP hit -> should close everything
    await monitorTick(cfg);
    expect((await getPositions())["BTCUSDT"]).toBeUndefined();
  });

  it("R-multiple scale-out closes the configured % at r×R profit", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.attachTakeProfit = false; // isolate the R logic
    cfg.trading.orders.rTakeProfit = {
      enabled: true,
      levels: [{ r: 1, closePercent: 50 }, { r: 2, closePercent: 50 }],
    };
    // entry 60000, SL 59000 -> R = 1000
    await handleIncomingMessage("BTCUSDT LONG Entry: 60000 SL: 59000", meta(), cfg);
    let pos = (await getPositions())["BTCUSDT"];
    expect(pos.initialRisk).toBe(1000);
    const q0 = pos.originalQty;

    stubFetchPrice(61000); // +1000 = 1R -> close 50%
    await monitorTick(cfg);
    pos = (await getPositions())["BTCUSDT"];
    expect(pos.qty).toBeCloseTo(q0 * 0.5, 6);
    expect(pos.rTargets[0].done).toBe(true);

    stubFetchPrice(62000); // +2000 = 2R -> close another 50% of original -> flat
    await monitorTick(cfg);
    expect((await getPositions())["BTCUSDT"]).toBeUndefined();
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

  it("filters news messages silently (no record, no position)", async () => {
    const cfg = settings();
    const before = (await getSignals()).length;
    await handleIncomingMessage(
      "今晚 CPI 數據公布，BTCUSDT 可能劇烈波動", meta(), cfg
    );
    // non-signals are dropped without any signal record
    expect((await getSignals()).length).toBe(before);
    expect((await getPositions())["BTCUSDT"]).toBeUndefined();
  });

  it("non-signal chatter is not recorded", async () => {
    const cfg = settings();
    const before = (await getSignals()).length;
    await handleIncomingMessage("gm 今天盤整，觀望為主", meta(), cfg);
    expect((await getSignals()).length).toBe(before);
  });

  it("cancel runs silently and purges the trade's records", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    await handleIncomingMessage("SOLUSDT LONG 5x Entry: 150 SL: 140", meta(), cfg);
    expect((await getPositions())["SOLUSDT"]).toBeDefined();
    expect((await getOrders()).some((o) => o.symbol === "SOLUSDT")).toBe(true);
    expect((await getSignals()).some((s) => s.symbol === "SOLUSDT")).toBe(true);

    await handleIncomingMessage("取消 SOLUSDT 掛單", meta(), cfg);

    // position removed, and no trace left in either log (silent background)
    expect((await getPositions())["SOLUSDT"]).toBeUndefined();
    expect((await getOrders()).some((o) => o.symbol === "SOLUSDT")).toBe(false);
    expect((await getSignals()).some((s) => s.symbol === "SOLUSDT")).toBe(false);
    expect((await getOrders()).some((o) => o.action === "cancel")).toBe(false);
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

  it("arms add levels beyond the price, then fills on the pullback (回踩)", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.addArmSeconds = 0; // arm immediately in tests
    await handleIncomingMessage(LONG_TERM, meta(), cfg);
    let positions = await getPositions();
    let pos = positions["ONEUSDT"];
    expect(pos).toBeDefined();
    expect(pos.side).toBe("short");
    expect(pos.pendingAdds.map((a) => a.level)).toEqual([0.00110614, 0.00103314]);

    // price falls beyond the first add level -> level arms, no fill yet
    stubFetchPrice(0.0011);
    await monitorTick(cfg);
    positions = await getPositions();
    pos = positions["ONEUSDT"];
    expect(pos.addCount).toBe(0);
    expect(pos.pendingAdds[0].armed).toBe(true);

    // price pulls back up to the level -> add fills
    stubFetchPrice(0.00111);
    await monitorTick(cfg);
    positions = await getPositions();
    pos = positions["ONEUSDT"];
    expect(pos.addCount).toBe(1);
    expect(pos.pendingAdds.map((a) => a.level)).toEqual([0.00103314]);
  });

  it("bounce back before the arm window resets the timer (no fill)", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.addArmSeconds = 3600; // impossible to arm within the test
    await handleIncomingMessage(
      LONG_TERM.replace("ONE/USDT", "TWO/USDT"), meta(), cfg
    );
    stubFetchPrice(0.0011); // beyond -> timer starts, not armed yet
    await monitorTick(cfg);
    stubFetchPrice(0.00115); // bounced back before arming -> reset
    await monitorTick(cfg);
    const pos = (await getPositions())["TWOUSDT"];
    expect(pos.addCount).toBe(0);
    expect(pos.pendingAdds[0].armed).toBe(false);
    expect(pos.pendingAdds[0].armedAt).toBeNull();
  });

  it("長線單升級信號 updates SL/TP and attaches the add plan to an existing position", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    // short-term open first
    await handleIncomingMessage(
      `🚨 加密掃描 Pro — 短線單信號
▼ 做空（Short）：APE/USDT
📍 進場： $1.00
🛑 止損： $1.05
🎯 止盈一： $0.95`,
      meta(), cfg
    );
    let pos = (await getPositions())["APEUSDT"];
    expect(pos).toBeDefined();
    expect(pos.stopLoss).toBe(1.05);

    // upgrade arrives for the same symbol -> update, not duplicate-reject
    await handleIncomingMessage(
      `🔼 加密掃描 Pro — 長線單升級信號
▼ 做空（Short）：APE/USDT
📍 進場： $1.00
🛑 止損： $1.02
🏁 最終止盈： $0.80
💰 加倉計劃（2 次）
 🥇 加倉 1： $0.93
 🥈 加倉 2： $0.88`,
      meta(), cfg
    );
    pos = (await getPositions())["APEUSDT"];
    expect(pos.stopLoss).toBe(1.02);
    expect(pos.takeProfits).toEqual([0.8]);
    expect(pos.pendingAdds.map((a) => a.level)).toEqual([0.93, 0.88]);

    const orders = await getOrders();
    expect(orders[0].action).toBe("upgrade");
    expect(orders[0].success).toBe(true);
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
