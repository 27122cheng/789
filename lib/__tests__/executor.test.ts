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
  // these cases stub Pionex-shaped responses; the OKX path is covered
  // separately below and in okx.test.ts
  s.exchange = "pionex";
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

  it("到價進場: limit entry waits, then the monitor fills at market on touch", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "limit";
    // current price 60500 (stubbed), entry 60000 below -> wait for price to fall
    stubFetchPrice(60500);
    await handleIncomingMessage(
      "BNBUSDT LONG Entry: 60000 SL: 59000 TP1: 61000", meta(), cfg
    );
    let pos = (await getPositions())["BNBUSDT"];
    expect(pos).toBeDefined();
    expect(pos.pendingEntry).toBeTruthy();
    expect(pos.qty).toBe(0);

    // price still above entry -> stays pending
    stubFetchPrice(60200);
    await monitorTick(cfg);
    expect((await getPositions())["BNBUSDT"].pendingEntry).toBeTruthy();

    // price reaches entry -> fills at market
    stubFetchPrice(60000);
    await monitorTick(cfg);
    pos = (await getPositions())["BNBUSDT"];
    expect(pos.pendingEntry).toBeNull();
    expect(pos.qty).toBeGreaterThan(0);
    expect(pos.initialRisk).toBeGreaterThan(0);
  });

  it("live limit entry rests a real order on Pionex, then fills when it leaves the book", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "limit";
    cfg.trading.liveTrading = true;
    cfg.pionex.apiKey = "k";
    cfg.pionex.apiSecret = "s";

    let price = 60500;
    let openOrders: any[] = [];
    const placed: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any = {};
      if (url.includes("/common/symbols")) {
        data = { symbols: [{ symbol: "XRP_USDT_PERP", baseStep: "0.001", quoteStep: "0.0001", minSizeLimit: "1" }] };
      } else if (url.includes("/market/tickers")) {
        data = { tickers: [{ close: String(price) }] };
      } else if (url.includes("/trade/openOrders")) {
        data = { orders: openOrders };
      } else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) {
        placed.push(body);
        data = { orderId: "OID-1" };
      }
      return { ok: true, status: 200, json: async () => ({ result: true, data }) };
    }));

    await handleIncomingMessage(
      "XRPUSDT LONG Entry: 60000 SL: 59000 TP1: 61000", meta(), cfg
    );

    // a genuine LIMIT order was sent to Pionex at the signal's entry price
    expect(placed).toHaveLength(1);
    expect(placed[0].type).toBe("LIMIT");
    expect(placed[0].price).toBe("60000.0000");
    expect(placed[0].positionSide).toBe("BOTH");
    let pos = (await getPositions())["XRPUSDT"];
    expect(pos.pendingEntry!.mode).toBe("limit_order");
    expect(pos.pendingEntry!.orderId).toBe("OID-1");
    expect(pos.qty).toBe(0);

    // while the order is still resting, nothing changes
    openOrders = [{ orderId: "OID-1" }];
    await monitorTick(cfg);
    expect((await getPositions())["XRPUSDT"].pendingEntry).toBeTruthy();

    // order leaves the book -> treated as filled at exactly the entry price
    openOrders = [];
    await monitorTick(cfg);
    pos = (await getPositions())["XRPUSDT"];
    expect(pos.pendingEntry).toBeNull();
    expect(pos.entryPrice).toBe(60000);
    expect(pos.qty).toBeGreaterThan(0);
  });

  it("watch mode enters on a wick that touched the level between polls", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "limit";
    cfg.trading.liveTrading = true;
    cfg.pionex.apiKey = "k";
    cfg.pionex.apiSecret = "s";

    let price = 60500;
    let low = 60400;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any = {};
      let result = true;
      if (url.includes("/common/symbols")) {
        data = { symbols: [{ symbol: "ADA_USDT_PERP", baseStep: "0.001", quoteStep: "0.0001" }] };
      } else if (url.includes("/market/tickers")) {
        data = { tickers: [{ close: String(price) }] };
      } else if (url.includes("/market/klines")) {
        data = { klines: [{ time: Date.now(), high: price, low }] };
      } else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) {
        // Pionex's price filter refuses the resting LIMIT order (the real
        // TRADE_PRICE_FILTER_DENIED case) -> falls back to watch mode;
        // MARKET orders still go through.
        if (body?.type === "LIMIT") result = false;
        else data = { orderId: "OID-M" };
      }
      return { ok: result, status: result ? 200 : 400, json: async () => ({ result, code: "TRADE_PRICE_FILTER_DENIED", data }) };
    }));

    await handleIncomingMessage(
      "ADAUSDT LONG Entry: 60000 SL: 59000 TP1: 61000", meta(), cfg
    );
    let pos = (await getPositions())["ADAUSDT"];
    expect(pos.pendingEntry!.mode).toBe("watch");

    // last price never reaches 60000, but the candle low wicked through it
    price = 60300;
    low = 59900;
    await monitorTick(cfg);
    pos = (await getPositions())["ADAUSDT"];
    expect(pos.pendingEntry).toBeNull();
    expect(pos.qty).toBeGreaterThan(0);
  });

  it("OKX: a live signal places a swap order sized in contracts", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "market";
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };

    const orders: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/public/instruments")) {
        data = [{ instId: "LINK-USDT-SWAP", ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.001" }];
      } else if (url.includes("/market/ticker")) {
        data = [{ last: "3000" }];
      } else if (url.includes("/account/set-leverage")) {
        data = [{ lever: "10" }];
      } else if (url.includes("algo")) {
        data = [];
      } else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) {
        orders.push(body);
        data = [{ ordId: "OKX-1", sCode: "0" }];
      }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    await handleIncomingMessage(
      "LINKUSDT LONG 10x Entry: 3000 SL: 2900 TP1: 3100", meta(), cfg
    );

    const pos = (await getPositions())["LINKUSDT"];
    expect(pos).toBeDefined();
    expect(pos.dryRun).toBe(false);
    expect(orders).toHaveLength(1);
    // 600 USDT / 3000 = 0.2 LINK -> 0.2 / 0.1 per contract = 2 contracts
    expect(orders[0].instId).toBe("LINK-USDT-SWAP");
    expect(orders[0].sz).toBe("2.0");
    expect(orders[0].side).toBe("buy");
  });

  it("OKX credential errors (50101) fail the trade instead of parking it", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "limit";

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/public/instruments")) {
        return { ok: true, status: 200, json: async () => ({ code: "0", data: [
          { instId: "DOT-USDT-SWAP", ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.001" },
        ] }) };
      }
      if (url.includes("/market/ticker")) {
        return { ok: true, status: 200, json: async () => ({ code: "0", data: [{ last: "3100" }] }) };
      }
      // every authenticated call is rejected: demo key used against live
      return { ok: true, status: 200, json: async () => ({
        code: "50101", msg: "APIKey does not match current environment.", data: [],
      }) };
    }));

    await handleIncomingMessage(
      "DOTUSDT LONG Entry: 3000 SL: 2900 TP1: 3100", meta(), cfg
    );

    // no phantom "waiting to enter" position is left behind
    expect((await getPositions())["DOTUSDT"]).toBeUndefined();
    const rec = (await getOrders()).find((o) => o.symbol === "DOTUSDT");
    expect(rec!.success).toBe(false);
    expect(rec!.message).toContain("OKX");
    expect(rec!.message).toContain("模擬盤");   // actionable hint, not a bare code
    expect(rec!.message).not.toContain("Pionex");
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
      moveToBreakevenOnTp1: false, breakevenOffsetPercent: 0.2,
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
    cfg.trading.autoArmAddLevels = true; // this test covers self-judged timing
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

describe("minimum order size policy", () => {
  function okxCfg() {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "market";
    // 3 USDT at 60000 = 0.00005 BTC, below the 0.0001 BTC minimum
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 3, percentBalance: 5, basis: "notional" };
    return cfg;
  }
  function stub(orders: any[]) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.01", minSz: "0.01", tickSz: "0.1" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "60000" }];
      else if (url.includes("algo")) data = [];
      else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) { orders.push(body); data = [{ ordId: "M-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));
  }

  it("lift: trades at the minimum and says so in the record", async () => {
    const cfg = okxCfg();
    cfg.trading.orders.belowMinSize = "lift";
    const orders: any[] = [];
    stub(orders);
    await handleIncomingMessage("BTCUSDT LONG Entry: 60000 SL: 59000", meta(), cfg);
    expect(orders).toHaveLength(1);
    expect((await getPositions())["BTCUSDT"]).toBeDefined();
    const rec = (await getOrders()).find((o) => o.symbol === "BTCUSDT" && o.success);
    expect(rec!.message).toContain("最低下單量");
    expect(rec!.message).toContain("6.00");  // 0.0001 BTC * 60000
  });

  it("skip: places nothing and opens no position", async () => {
    const cfg = okxCfg();
    cfg.trading.orders.belowMinSize = "skip";
    const orders: any[] = [];
    stub(orders);
    await handleIncomingMessage("ETHUSDT LONG Entry: 60000 SL: 59000", meta(), cfg);
    expect(orders).toHaveLength(0);
    expect((await getPositions())["ETHUSDT"]).toBeUndefined();
  });
});

describe("size step rounding", () => {
  it("reports when the configured amount was rounded down to the step", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "market";
    // 10 USDT at 64000: 0.00015625 BTC, floored to the 0.0001 step = 6.40 USDT
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 10, percentBalance: 5, basis: "notional" };

    const orders: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "AVAX-USDT-SWAP", ctVal: "0.01", lotSz: "0.01", minSz: "0.01", tickSz: "0.1" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "64000" }];
      else if (url.includes("algo")) data = [];
      else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) { orders.push(body); data = [{ ordId: "S-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    await handleIncomingMessage("AVAXUSDT LONG Entry: 64000 SL: 63000", meta(), cfg);

    expect(orders[0].sz).toBe("0.01");   // one contract-step, not zero
    const rec = (await getOrders()).find((o) => o.symbol === "AVAXUSDT" && o.success);
    expect(rec!.message).toContain("向下對齊");
    expect(rec!.message).toContain("6.40");   // real notional, not the configured 10
  });
});

describe("exchange-side stops", () => {
  it("rests SL/TP on OKX after the entry fills, and cancels them on close", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.orders.entryType = "market";
    cfg.trading.orders.exchangeStops = true;
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };

    const algos: any[] = [];
    const cancels: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "TRX-USDT-SWAP", ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.001" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "3000" }];
      else if (url.includes("/orders-algo-pending")) data = algos.length ? [{ algoId: "A-1" }] : [];
      else if (url.includes("/cancel-algos")) { cancels.push(body); data = [{ algoId: "A-1" }]; }
      else if (url.includes("/order-algo")) { algos.push(body); data = [{ algoId: "A-1", sCode: "0" }]; }
      else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) data = [{ ordId: "T-1", sCode: "0" }];
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    await handleIncomingMessage(
      "TRXUSDT LONG Entry: 3000 SL: 2900 TP1: 3100 TP2: 3200", meta(), cfg
    );

    // 分批止盈: a stop covering the whole position + one order per target
    expect(algos.map((a) => a.ordType)).toEqual(["conditional", "conditional", "conditional"]);
    expect(algos[0].instId).toBe("TRX-USDT-SWAP");
    expect(algos[0].side).toBe("sell");              // closing side of a long
    expect(algos[0].slTriggerPx).toBe("2900.000");
    expect(algos.map((a) => a.tpTriggerPx).filter(Boolean)).toEqual(["3100.000", "3200.000"]);
    const rec = (await getOrders()).find((o) => o.symbol === "TRXUSDT" && o.success);
    expect(rec!.message).toContain("交易所止盈止損已掛");

    // closing the position clears the exchange stop too
    await handleIncomingMessage("TRXUSDT 平倉", meta(), cfg);
    expect((await getPositions())["TRXUSDT"]).toBeUndefined();
    expect(cancels.length).toBeGreaterThan(0);
  });
});

describe("leverage fallback", () => {
  it("uses the max when the signal states no leverage", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.leverage = { default: 5, max: 30, whenUnspecified: "max" };
    await handleIncomingMessage("APTUSDT LONG Entry: 60000 SL: 59000", meta(), cfg);
    expect((await getPositions())["APTUSDT"].leverage).toBe(30);
  });

  it("uses the default instead when configured that way", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.leverage = { default: 5, max: 30, whenUnspecified: "default" };
    await handleIncomingMessage("OPUSDT LONG Entry: 60000 SL: 59000", meta(), cfg);
    expect((await getPositions())["OPUSDT"].leverage).toBe(5);
  });

  it("still honours a leverage the signal does state, capped at the max", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.leverage = { default: 5, max: 30, whenUnspecified: "max" };
    await handleIncomingMessage("SUIUSDT LONG 12x Entry: 60000 SL: 59000", meta(), cfg);
    expect((await getPositions())["SUIUSDT"].leverage).toBe(12);
  });
});

describe("追蹤止損 signal", () => {
  it("moves the stop-loss from a 建議止損調整 message", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    await handleIncomingMessage("NEARUSDT LONG Entry: 60000 SL: 59000 TP1: 61000", meta(), cfg);
    expect((await getPositions())["NEARUSDT"].stopLoss).toBe(59000);

    await handleIncomingMessage(
      `🔔 加密掃描 Pro — 建議止損調整\nNEAR/USDT\n新止損： $59500`,
      meta(), cfg
    );
    expect((await getPositions())["NEARUSDT"].stopLoss).toBe(59500);
    const rec = (await getOrders()).find((o) => o.action === "update_sl" && o.symbol === "NEARUSDT");
    expect(rec!.success).toBe(true);
  });
});

describe("self-healing exchange stops", () => {
  it("places protection on the next tick for a position that has none", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "market";
    cfg.trading.orders.exchangeStops = false;   // opened before the feature
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };

    const algos: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "WLD-USDT-SWAP", ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.0001" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "3000" }];
      else if (url.includes("/orders-algo-pending")) data = algos.length ? [{ algoId: "A-9" }] : [];
      else if (url.includes("/cancel-algos")) data = [{ algoId: "A-9" }];
      else if (url.includes("/order-algo")) { algos.push(body); data = [{ algoId: "A-9", sCode: "0" }]; }
      else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) data = [{ ordId: "W-1", sCode: "0" }];
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    await handleIncomingMessage("WLDUSDT SHORT Entry: 3000 SL: 3100 TP1: 2900", meta(), cfg);
    expect((await getPositions())["WLDUSDT"]).toBeDefined();
    expect(algos).toHaveLength(0);   // feature was off at entry -> unprotected

    // turn it on: the very next monitor tick notices and protects the position
    cfg.trading.orders.exchangeStops = true;
    await monitorTick(cfg);
    expect(algos).toHaveLength(1);
    expect(algos[0].instId).toBe("WLD-USDT-SWAP");
    expect(algos[0].side).toBe("buy");            // closing side of a short
    expect(algos[0].slTriggerPx).toBe("3100.0000");
    const rec = (await getOrders()).find((o) => o.action === "stops_synced");
    expect(rec!.message).toContain("補掛保護單");

    // already protected -> no duplicate on the following tick
    await monitorTick(cfg);
    expect(algos).toHaveLength(1);
  });
});

describe("reconciling with the exchange", () => {
  it("adopts a position the exchange filled while the monitor was down", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "limit";
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };

    let exchangePositions: any[] = [];
    let placed = false;   // nothing rests until we actually place the entry
    const algos: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "SEI-USDT-SWAP", ctVal: "1", lotSz: "1", minSz: "1", tickSz: "0.0001" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "3.1" }];
      else if (url.includes("/account/positions")) data = exchangePositions;
      else if (url.includes("/orders-algo-pending")) data = algos.length ? [{ algoId: "A-3" }] : [];
      else if (url.includes("/order-algo")) { algos.push(body); data = [{ algoId: "A-3", sCode: "0" }]; }
      else if (url.includes("/trade/orders-pending")) data = placed ? [{ ordId: "P-1" }] : [];
      else if (url.includes("/trade/order")) { placed = true; data = [{ ordId: "P-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    // entry rests below the market -> tracked as pending, qty 0
    await handleIncomingMessage("SEIUSDT LONG Entry: 3.0 SL: 2.8 TP1: 3.4", meta(), cfg);
    let pos = (await getPositions())["SEIUSDT"];
    expect(pos.pendingEntry).toBeTruthy();
    expect(pos.qty).toBe(0);

    // OKX filled it while nothing was watching
    exchangePositions = [{ instId: "SEI-USDT-SWAP", pos: "200", posSide: "net", avgPx: "3.0" }];
    await monitorTick(cfg);

    pos = (await getPositions())["SEIUSDT"];
    expect(pos.pendingEntry).toBeNull();
    expect(pos.qty).toBe(200);          // 200 contracts x ctVal 1
    expect(pos.entryPrice).toBe(3.0);
    expect(pos.initialRisk).toBeCloseTo(0.2, 6);
    // and the same tick protects it
    expect(algos.length).toBeGreaterThan(0);
  });
});

describe("TP/SL attached to the entry order", () => {
  function okxCfg() {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "market";
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };
    return cfg;
  }
  function stub(orders: any[], algos: any[], instId: string, opts: { rejectAttach?: boolean } = {}) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId, ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.001" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "3000" }];
      else if (url.includes("/account/positions")) data = [];
      else if (url.includes("/orders-algo-pending")) data = [];
      else if (url.includes("/order-algo")) { algos.push(body); data = [{ algoId: "A-7", sCode: "0" }]; }
      else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) {
        if (opts.rejectAttach && body?.attachAlgoOrds) {
          return { ok: true, status: 200, json: async () => ({
            code: "1", data: [{ sCode: "51076", sMsg: "attachAlgoOrds invalid" }],
          }) };
        }
        orders.push(body);
        data = [{ ordId: "F-1", sCode: "0" }];
      }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));
  }

  it("sends SL and TP as separate attachments on the entry order", async () => {
    const cfg = okxCfg();
    const orders: any[] = [];
    const algos: any[] = [];
    stub(orders, algos, "FIL-USDT-SWAP");
    await handleIncomingMessage("FILUSDT LONG Entry: 3000 SL: 2900 TP1: 3100", meta(), cfg);

    expect(orders).toHaveLength(1);
    const attach = orders[0].attachAlgoOrds;
    expect(attach).toHaveLength(2);                    // never combined (51076)
    expect(attach[0].slTriggerPx).toBe("2900.000");
    expect(attach[0].slOrdPx).toBe("-1");
    expect(attach[1].tpTriggerPx).toBe("3100.000");
    // a single target is fully covered by the attachment - no extra algo orders
    expect(algos).toHaveLength(0);
    const rec = (await getOrders()).find((o) => o.symbol === "FILUSDT" && o.success);
    expect(rec!.message).toContain("已附帶止盈止損");
  });

  it("still opens the position when the attachment is rejected", async () => {
    const cfg = okxCfg();
    const orders: any[] = [];
    const algos: any[] = [];
    stub(orders, algos, "GRT-USDT-SWAP", { rejectAttach: true });
    await handleIncomingMessage("GRTUSDT SHORT Entry: 3000 SL: 3100 TP1: 2900", meta(), cfg);

    // retried without the attachment rather than losing the trade
    expect(orders).toHaveLength(1);
    expect(orders[0].attachAlgoOrds).toBeUndefined();
    expect((await getPositions())["GRTUSDT"]).toBeDefined();
    // and protection was placed separately instead
    expect(algos.length).toBeGreaterThan(0);
  });
});

describe("加倉確認 tranche", () => {
  it("rests a limit order at the tranche price, leaves the main stop alone, then folds the fill in", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "market";
    cfg.trading.addPositionUsdt = 600;
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };

    const orders: any[] = [];
    let openOrders: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "ARB-USDT-SWAP", ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "100" }];
      else if (url.includes("/account/positions")) data = [];
      else if (url.includes("/orders-algo-pending")) data = [];
      else if (url.includes("/trade/orders-pending")) data = openOrders;
      else if (url.includes("algo")) data = [{ algoId: "A-1", sCode: "0" }];
      else if (url.includes("/trade/order")) { orders.push(body); data = [{ ordId: "ADD-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    // main position first
    await handleIncomingMessage("ARBUSDT LONG Entry: 100 SL: 99 TP1: 110", meta(), cfg);
    const before = (await getPositions())["ARBUSDT"];
    expect(before).toBeDefined();
    const qtyBefore = before.qty;

    await handleIncomingMessage(
      `📌 加倉確認 #1｜請掛單 — ARB ▲ 做多

✅ 價格已站上加倉點上方並持續 2 分鐘，確認非假突破

🎯 掛限價單於：$103（回踩此價成交）
🛑 此筆止損：$101.5
📌 主倉進場：$100　主倉止損：$99`,
      meta(), cfg
    );

    let pos = (await getPositions())["ARBUSDT"];
    // a resting LIMIT order at the tranche price, not a market buy
    const limitOrder = orders.find((o) => o.ordType === "limit");
    expect(limitOrder.px).toBe("103.0");
    // the tranche is protected on the order itself, at the MAIN position's
    // stop - not the tighter tranche stop, so it cannot be stopped out alone
    expect(limitOrder.attachAlgoOrds).toHaveLength(2);
    expect(limitOrder.attachAlgoOrds[0].slTriggerPx).toBe("99.0");
    expect(limitOrder.attachAlgoOrds[1].tpTriggerPx).toBe("110.0");
    // the tranche's stop must NOT retighten the whole position
    expect(pos.stopLoss).toBe(99);
    expect(pos.qty).toBe(qtyBefore);           // nothing added until it fills
    expect(pos.pendingAdds[0].orderId).toBe("ADD-1");

    // still resting -> unchanged
    openOrders = [{ ordId: "ADD-1" }];
    await monitorTick(cfg);
    expect((await getPositions())["ARBUSDT"].qty).toBe(qtyBefore);

    // leaves the book -> folded into the position at the tranche price
    openOrders = [];
    await monitorTick(cfg);
    pos = (await getPositions())["ARBUSDT"];
    expect(pos.qty).toBeGreaterThan(qtyBefore);
    expect(pos.addCount).toBe(1);
    expect(pos.entryPrice).toBeGreaterThan(100);   // averaged up toward 103
    expect(pos.stopLoss).toBe(99);                 // main stop still untouched
    // once filled, protection is re-placed for the FULL position size
    const fillRec = (await getOrders()).find(
      (o) => o.symbol === "ARBUSDT" && o.message.includes("加倉限價單成交")
    );
    expect(fillRec!.message).toContain("交易所止盈止損已掛");
  });
});

describe("never stack a second position on the same symbol", () => {
  function okxCfg() {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = {
      apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false,
    };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "market";
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };
    return cfg;
  }
  function stub(orders: any[], instId: string, held: any[]) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId, ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "100" }];
      else if (url.includes("/account/positions")) data = held;
      else if (url.includes("/orders-algo-pending")) data = [];
      else if (url.includes("algo")) data = [{ algoId: "A-1", sCode: "0" }];
      else if (url.includes("orders-pending")) data = [];
      else if (url.includes("/trade/order")) { orders.push(body); data = [{ ordId: "X-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));
  }

  it("adopts an untracked same-direction position instead of opening another", async () => {
    const cfg = okxCfg();
    const orders: any[] = [];
    // OKX holds 30 INJ long that our tracker knows nothing about
    stub(orders, "INJ-USDT-SWAP", [
      { instId: "INJ-USDT-SWAP", pos: "300", posSide: "net", avgPx: "98" },
    ]);
    await handleIncomingMessage("INJUSDT LONG Entry: 100 SL: 95 TP1: 110", meta(), cfg);

    // no entry order was sent
    expect(orders.filter((o) => o.ordType).length).toBe(0);
    const pos = (await getPositions())["INJUSDT"];
    expect(pos.qty).toBe(30);            // 300 contracts x ctVal 0.1
    expect(pos.entryPrice).toBe(98);     // the exchange's average, not 100
    expect(pos.stopLoss).toBe(95);       // this signal's stop now manages it
    const rec = (await getOrders()).find((o) => o.symbol === "INJUSDT");
    expect(rec!.message).toContain("未重複下單");
  });

  it("refuses when the held position is the opposite direction", async () => {
    const cfg = okxCfg();
    const orders: any[] = [];
    stub(orders, "TIA-USDT-SWAP", [
      { instId: "TIA-USDT-SWAP", pos: "-300", posSide: "net", avgPx: "98" },
    ]);
    await handleIncomingMessage("TIAUSDT LONG Entry: 100 SL: 95 TP1: 110", meta(), cfg);

    expect(orders.filter((o) => o.ordType).length).toBe(0);
    expect((await getPositions())["TIAUSDT"]).toBeUndefined();
    const rec = (await getOrders()).find((o) => o.symbol === "TIAUSDT");
    expect(rec!.success).toBe(false);
    expect(rec!.message).toContain("方向衝突");
  });
});

describe("sizing basis", () => {
  it("margin basis multiplies the amount by the leverage", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.leverage = { default: 10, max: 20, whenUnspecified: "max" };
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 10, percentBalance: 5, basis: "margin" };

    await handleIncomingMessage("RUNEUSDT LONG Entry: 100 SL: 95", meta(), cfg);
    const pos = (await getPositions())["RUNEUSDT"];
    // 10 USDT margin at 20x -> a 200 USDT position -> 2 coins at 100
    expect(pos.leverage).toBe(20);
    expect(pos.sizeUsdt).toBe(200);
    expect(pos.qty).toBeCloseTo(2, 6);
  });

  it("notional basis takes the amount as the position value", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.leverage = { default: 10, max: 20, whenUnspecified: "max" };
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 10, percentBalance: 5, basis: "notional" };

    await handleIncomingMessage("LDOUSDT LONG Entry: 100 SL: 95", meta(), cfg);
    const pos = (await getPositions())["LDOUSDT"];
    expect(pos.sizeUsdt).toBe(10);
    expect(pos.qty).toBeCloseTo(0.1, 6);
  });

  it("a signal-specified amount is taken at face value", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.leverage = { default: 10, max: 20, whenUnspecified: "max" };
    cfg.trading.sizing = { mode: "signal", fixedUsdt: 10, percentBalance: 5, basis: "margin" };

    await handleIncomingMessage("GMXUSDT LONG Entry: 100 SL: 95 倉位 50 USDT", meta(), cfg);
    const pos = (await getPositions())["GMXUSDT"];
    expect(pos.sizeUsdt).toBe(50);
  });
});

describe("加倉 notification sequence end-to-end", () => {
  function stubOkx(orders: any[], cancels: any[], instId: string, openOrders: () => any[]) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId, ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "100" }];
      else if (url.includes("/account/positions")) data = [];
      else if (url.includes("/orders-algo-pending")) data = [];
      else if (url.includes("/trade/orders-pending")) data = openOrders();
      else if (url.includes("/cancel-order")) { cancels.push(body); data = [{ ordId: body.ordId }]; }
      else if (url.includes("algo")) data = [{ algoId: "A-1", sCode: "0" }];
      else if (url.includes("/trade/order")) { orders.push(body); data = [{ ordId: "AD-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));
  }
  function cfgFor() {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = { apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 30;   // must not block management signals
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "market";
    cfg.trading.addPositionUsdt = 600;
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };
    return cfg;
  }

  it("加倉訊號 places nothing; 請掛單 places; 掛單失效 cancels only that order", async () => {
    const cfg = cfgFor();
    const orders: any[] = [];
    const cancels: any[] = [];
    let resting: any[] = [];
    stubOkx(orders, cancels, "ENA-USDT-SWAP", () => resting);

    await handleIncomingMessage("ENAUSDT LONG Entry: 100 SL: 99 TP1: 110", meta(), cfg);
    const entryOrders = orders.length;
    expect((await getPositions())["ENAUSDT"]).toBeDefined();

    // ① announced only -> nothing placed, even though it names a price+stop
    await handleIncomingMessage(
      "➕ 加倉訊號 #1 — ENA ▲ 做多\n加倉價位：$103\n預計止損：$101.5", meta(), cfg
    );
    expect(orders).toHaveLength(entryOrders);
    expect((await getPositions())["ENAUSDT"].pendingAdds).toHaveLength(0);
    const planRec = (await getOrders()).find((o) => o.action === "add_plan");
    expect(planRec!.message).toContain("等「加倉確認｜請掛單」");

    // ② confirmed -> the tranche order goes out, despite the cooldown
    await handleIncomingMessage(
      "📌 加倉確認 #1｜請掛單 — ENA ▲ 做多\n🎯 掛限價單於：$103\n🛑 此筆止損：$101.5",
      meta(), cfg
    );
    const pos = (await getPositions())["ENAUSDT"];
    expect(pos.pendingAdds).toHaveLength(1);
    expect(orders.length).toBe(entryOrders + 1);

    // ④ timed out -> that order is cancelled and the POSITION survives
    resting = [{ ordId: "AD-1" }];
    await handleIncomingMessage("⏹ 加倉掛單失效 #1 — ENA ▲ 做多\n請撤單", meta(), cfg);
    expect(cancels.map((c) => c.ordId)).toContain("AD-1");
    const after = (await getPositions())["ENAUSDT"];
    expect(after).toBeDefined();                 // position NOT closed
    expect(after.pendingAdds).toHaveLength(0);
    expect(after.qty).toBeGreaterThan(0);
  });

  it("加倉確認通知 moves the stop through, even inside the cooldown", async () => {
    const cfg = cfgFor();
    const orders: any[] = [];
    const cancels: any[] = [];
    stubOkx(orders, cancels, "AAVE-USDT-SWAP", () => []);

    await handleIncomingMessage("AAVEUSDT LONG Entry: 100 SL: 99 TP1: 110", meta(), cfg);
    expect((await getPositions())["AAVEUSDT"].stopLoss).toBe(99);

    await handleIncomingMessage(
      "📈 加倉確認通知 #1 — AAVE ▲ 做多\n成交價：$103\n🔧 止損上移至：$101.8",
      meta(), cfg
    );
    expect((await getPositions())["AAVEUSDT"].stopLoss).toBe(101.8);
  });
});

describe("加倉計劃 levels vs 加倉確認 signals", () => {
  it("does not self-fill plan levels when the provider confirms adds itself", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.addArmSeconds = 0;          // would arm instantly if enabled
    cfg.trading.autoArmAddLevels = false;   // provider drives adds

    await handleIncomingMessage(
      `🔵 加密掃描 Pro — 長線單升級信號\nJTO/USDT 做多\n進場： $100\n止損： $95\n止盈一： $120\n加倉 1： $103`,
      meta(), cfg
    );
    let pos = (await getPositions())["JTOUSDT"];
    expect(pos.pendingAdds).toHaveLength(1);   // level remembered for reference
    const qty0 = pos.qty;

    // price runs beyond the level and pulls back - would trigger a self-add
    stubFetchPrice(104);
    await monitorTick(cfg);
    stubFetchPrice(103);
    await monitorTick(cfg);

    pos = (await getPositions())["JTOUSDT"];
    expect(pos.addCount).toBe(0);
    expect(pos.qty).toBe(qty0);
    expect(pos.pendingAdds).toHaveLength(1);   // still waiting on 加倉確認
  });

  it("still self-fills when explicitly enabled", async () => {
    const cfg = settings();
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.addArmSeconds = 0;
    cfg.trading.autoArmAddLevels = true;

    await handleIncomingMessage(
      `🔵 加密掃描 Pro — 長線單升級信號\nPYTH/USDT 做多\n進場： $100\n止損： $95\n止盈一： $120\n加倉 1： $103`,
      meta(), cfg
    );
    const qty0 = (await getPositions())["PYTHUSDT"].qty;

    stubFetchPrice(104);
    await monitorTick(cfg);
    stubFetchPrice(103);
    await monitorTick(cfg);

    const pos = (await getPositions())["PYTHUSDT"];
    expect(pos.addCount).toBe(1);
    expect(pos.qty).toBeGreaterThan(qty0);
  });
});

describe("an add runs on the same stop as the main position", () => {
  it("uses the main stop before the fill and after, never the tranche's own", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = { apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "market";
    cfg.trading.addPositionUsdt = 600;
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };

    const orders: any[] = [];
    const algos: any[] = [];
    let resting: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "SEIB-USDT-SWAP", ctVal: "0.1", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "100" }];
      else if (url.includes("/account/positions")) data = [];
      else if (url.includes("/orders-algo-pending")) data = [];
      else if (url.includes("/trade/orders-pending")) data = resting;
      else if (url.includes("/order-algo")) { algos.push(body); data = [{ algoId: "A-1", sCode: "0" }]; }
      else if (url.includes("algo")) data = [{ algoId: "A-1", sCode: "0" }];
      else if (url.includes("/trade/order")) { orders.push(body); data = [{ ordId: "SB-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    await handleIncomingMessage("SEIBUSDT LONG Entry: 100 SL: 99 TP1: 110", meta(), cfg);

    // the tranche names a tighter stop of its own; it must not be used
    await handleIncomingMessage(
      `📌 加倉確認 #1｜請掛單 — SEIB ▲ 做多
🎯 掛限價單於：$103（回踩此價成交）
🛑 此筆止損：$101.5
📌 主倉進場：$100　主倉止損：$99`,
      meta(), cfg
    );
    const limit = orders.find((o) => o.ordType === "limit");
    expect(limit.attachAlgoOrds[0].slTriggerPx).toBe("99.0");

    // after the fill, everything is still protected at the one main stop
    resting = [];
    await monitorTick(cfg);
    const pos = (await getPositions())["SEIBUSDT"];
    expect(pos.addCount).toBe(1);
    expect(pos.stopLoss).toBe(99);
    const lastStop = algos.filter((a) => a.slTriggerPx).pop();
    expect(lastStop.slTriggerPx).toBe("99.0");

    // and a 止損上移 moves the whole position together
    await handleIncomingMessage(
      `📈 加倉確認通知 #1 — SEIB ▲ 做多\n成交價：$103\n🔧 止損上移至：$101.8`,
      meta(), cfg
    );
    expect((await getPositions())["SEIBUSDT"].stopLoss).toBe(101.8);
    expect(algos.filter((a) => a.slTriggerPx).pop().slTriggerPx).toBe("101.8");
  });
});

describe("an untracked resting order also blocks a new entry", () => {
  it("refuses to open when the exchange already has a pending order for the symbol", async () => {
    const cfg = settings();
    cfg.exchange = "okx";
    cfg.okx = { apiKey: "k", apiSecret: "s", passphrase: "p",
      baseUrl: "https://www.okx.com", tdMode: "cross", demo: false };
    cfg.trading.liveTrading = true;
    cfg.trading.risk.cooldownSeconds = 0;
    cfg.trading.risk.maxOpenPositions = 50;
    cfg.trading.orders.entryType = "market";
    cfg.trading.sizing = { mode: "fixed_usdt", fixedUsdt: 600, percentBalance: 5, basis: "notional" };

    const orders: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      let data: any[] = [];
      if (url.includes("/account/config")) data = [{ posMode: "net_mode" }];
      else if (url.includes("/public/instruments")) {
        data = [{ instId: "JASMY-USDT-SWAP", ctVal: "1", lotSz: "1", minSz: "1", tickSz: "0.0001" }];
      } else if (url.includes("/market/ticker")) data = [{ last: "100" }];
      else if (url.includes("/account/positions")) data = [];       // no position…
      else if (url.includes("/orders-algo-pending")) data = [];
      // …but an order is resting that this system never recorded
      else if (url.includes("orders-pending")) data = [{ ordId: "ORPHAN-1" }];
      else if (url.includes("algo")) data = [{ algoId: "A-1", sCode: "0" }];
      else if (url.includes("/trade/order")) { orders.push(body); data = [{ ordId: "N-1", sCode: "0" }]; }
      return { ok: true, status: 200, json: async () => ({ code: "0", data }) };
    }));

    await handleIncomingMessage("JASMYUSDT LONG Entry: 100 SL: 95 TP1: 110", meta(), cfg);

    expect(orders).toHaveLength(0);                       // nothing was sent
    expect((await getPositions())["JASMYUSDT"]).toBeUndefined();
    const rec = (await getOrders()).find((o) => o.symbol === "JASMYUSDT");
    expect(rec!.success).toBe(false);
    expect(rec!.message).toContain("已有 1 筆");
    expect(rec!.message).toContain("未下任何單");
  });
});
